/**
 * Browser Bridge — Client half.
 *
 * Runs inside the DeepSeek Harness web GUI page. It finds the sidebar
 * browser's frame elements (`[data-sidebar-browser-frame]`: Electron
 * `<webview>` on Desktop, `<iframe>` on Web), reports their state to the Host
 * half, polls for commands, executes them against the frames, and answers.
 *
 * Desktop `<webview>` elements expose the full Electron embedder API from this
 * page (executeJavaScript / getURL / getTitle / capturePage). Some Electron
 * builds relay script REJECTIONS but drop resolved VALUES, so every evaluation
 * runs once inside a nonce envelope that (a) returns the value through the
 * normal channel when it works and (b) leaves the result encoded in the page's
 * own `document.title`, from which the embedder reads it back — guaranteeing
 * exactly ONE execution per command on every build.
 */
window.__ModuleLoader__.load({
  id: '@alvinlui-hk/dsh-browser-bridge',
  factory(require) {
    const clientId = 'gui-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
    const platform = globalThis.dshDesktop?.protocolVersion === 1 ? 'desktop' : 'web'
    let cursor = 0
    let lastTargetFrameId = null

    // Frame execution queues are shared across plugin hot-reloads via a global
    // symbol, so a stale instance can never interleave with a fresh one.
    const FRAME_QUEUES_KEY = Symbol.for('dsh-browser-bridge.frameQueues')
    if (!globalThis[FRAME_QUEUES_KEY]) globalThis[FRAME_QUEUES_KEY] = new WeakMap()
    const frameQueues = globalThis[FRAME_QUEUES_KEY]

    let frameSeq = 0
    const frameIds = new WeakMap()

    const frameIdOf = (el) => {
      let id = frameIds.get(el)
      if (id === undefined) {
        frameSeq += 1
        id = 'frame-' + frameSeq
        frameIds.set(el, id)
      }
      return id
    }

    const isVisible = (el) => {
      if (!el.isConnected) return false
      const rects = el.getClientRects()
      return rects.length > 0 && el.offsetWidth > 0 && el.offsetHeight > 0
    }

    const safe = (fn) => {
      try {
        return fn()
      } catch {
        return undefined
      }
    }

    const frameElements = () => Array.from(document.querySelectorAll('[data-sidebar-browser-frame]'))

    const describeFrames = () =>
      frameElements().map((el) => {
        const kind = el.getAttribute('data-sidebar-browser-frame') === 'webview' ? 'webview' : 'iframe'
        const base = {
          id: frameIdOf(el),
          kind,
          visible: isVisible(el),
          url: null,
          title: null,
          scriptable: false,
        }
        if (kind === 'webview') {
          const url = safe(() => (typeof el.getURL === 'function' ? el.getURL() : undefined))
          base.url = typeof url === 'string' && url.length > 0 ? url.slice(0, 500) : null
          const title = safe(() => (typeof el.getTitle === 'function' ? el.getTitle() : undefined))
          const pollutedTitle = typeof title === 'string' && title.startsWith(TITLE_TAG)
          base.title = typeof title === 'string' && title.length > 0 && !pollutedTitle ? title.slice(0, 500) : null
          base.scriptable = typeof el.executeJavaScript === 'function'
        } else {
          const doc = safe(() => el.contentDocument)
          if (doc) {
            base.url = safe(() => (doc.location ? String(doc.location.href) : null)) ?? null
            base.title = typeof doc.title === 'string' && doc.title.length > 0 ? doc.title.slice(0, 500) : null
            base.scriptable = true
          }
        }
        return base
      })

    const findFrame = (frameId) => {
      const list = frameElements()
      if (list.length === 0) throw new Error('no Browser sidebar tab is open — the user must open the Browser panel first')
      if (typeof frameId === 'string' && frameId.length > 0) {
        const found = list.find((el) => frameIdOf(el) === frameId)
        if (found === undefined) {
          throw new Error(`browser frame "${frameId}" is not mounted (tab closed or sidebar switched) — run browser_status for current ids`)
        }
        lastTargetFrameId = frameId
        return found
      }
      const visible = list.filter((el) => isVisible(el))
      if (visible.length > 0) {
        const el = visible[visible.length - 1]
        lastTargetFrameId = frameIdOf(el)
        return el
      }
      if (lastTargetFrameId !== null) {
        const remembered = list.find((el) => frameIdOf(el) === lastTargetFrameId)
        if (remembered !== undefined) return remembered
      }
      return list[list.length - 1]
    }

    const kindOf = (el) => (el.getAttribute('data-sidebar-browser-frame') === 'webview' ? 'webview' : 'iframe')

    const jsonSafe = (value) => {
      if (value === undefined) return null
      try {
        const encoded = JSON.stringify(value)
        return encoded === undefined ? String(value) : JSON.parse(encoded)
      } catch {
        try {
          return String(value)
        } catch {
          return null
        }
      }
    }

    // ── frame evaluation ───────────────────────────────────────────────────

    const withFrameQueue = (el, run) => {
      const tail = frameQueues.get(el) ?? Promise.resolve()
      const next = tail.then(run, run)
      frameQueues.set(el, next.catch(() => {}))
      return next
    }

    const TITLE_TAG = '__dshbb__'

    const buildEnvelopeCode = (nonce, expression) => `(async () => {
  const nonce = '${nonce}'
  const flag = '__dshbb_done_' + nonce
  if (window[flag]) return { __dshbb: nonce }
  try {
    const __value = await (${expression})
    const __json = JSON.stringify(__value === undefined ? null : __value)
    const __bytes = new TextEncoder().encode(__json)
    let __bin = ''
    for (const __b of __bytes) __bin += String.fromCharCode(__b)
    const __payload = '${TITLE_TAG}${nonce}:' + btoa(__bin)
    document.title = __payload.length <= 480000 ? __payload : '${TITLE_TAG}${nonce}:ERR:' + encodeURIComponent('result too large for the title channel; lower maxChars')
    try { window[flag] = true } catch (e) {}
    return { __dshbb: nonce, value: __value === undefined ? null : __value }
  } catch (e) {
    const __msg = e && e.message ? e.message : String(e)
    document.title = '${TITLE_TAG}${nonce}:ERR:' + encodeURIComponent(__msg)
    try { window[flag] = true } catch (e2) {}
    return { __dshbb: nonce, error: __msg }
  }
})()`

    const decodeTitlePayload = (raw, nonce) => {
      if (typeof raw !== 'string') return undefined
      const marker = `${TITLE_TAG}${nonce}:`
      if (!raw.startsWith(marker)) return undefined
      const payload = raw.slice(marker.length)
      if (payload.startsWith('ERR:')) {
        let message = 'bridge title-channel error'
        try {
          message = decodeURIComponent(payload.slice(4)) || message
        } catch {
          /* keep the generic message */
        }
        throw new Error(message)
      }
      const bin = atob(payload)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes))
    }

    const getTitle = (el) => {
      const title = safe(() => (typeof el.getTitle === 'function' ? el.getTitle() : undefined))
      return typeof title === 'string' ? title : undefined
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * Evaluate `code` inside the frame with exactly ONE execution, on every
     * Electron build: the code returns a nonce envelope through the normal
     * channel when the build relays values, and simultaneously parks the
     * result in the page title for builds whose value relay drops it. The
     * nonce means a page can never forge a payload and a re-run always no-ops.
     */
    const evalInFrame = async (el, code, diag) => {
      const kind = kindOf(el)
      if (kind === 'webview') {
        if (typeof el.executeJavaScript !== 'function') {
          throw new Error('webview scripting is unavailable in this build')
        }
        return await withFrameQueue(el, async () => {
          const nonce = Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
          // Capture BEFORE any code runs: the envelope parks its payload in
          // document.title, so the original must be read first or the
          // "restore" would restore the payload itself. A title that already
          // starts with the tag is stale pollution from an older build —
          // restoring it would just propagate garbage, so it restores ''.
          const originalTitleRaw = getTitle(el)
          const originalTitle =
            typeof originalTitleRaw === 'string' && !originalTitleRaw.startsWith(TITLE_TAG)
              ? originalTitleRaw
              : ''
          let decoded
          let relay = null
          let titleRaw
          let failure = null
          let direct
          try {
            direct = await el.executeJavaScript(buildEnvelopeCode(nonce, code), false)
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error))
          }
          if (failure === null && direct && typeof direct === 'object' && direct.__dshbb === nonce) {
            relay = 'direct'
            if (direct.error) failure = new Error('page evaluation failed: ' + direct.error)
            else decoded = direct.value
          } else if (failure === null) {
            // This build drops resolved values: the code above already ran once
            // and parked its payload in document.title — read it back.
            relay = 'title-channel'
            const deadline = Date.now() + 2500
            while (Date.now() < deadline) {
              titleRaw = getTitle(el)
              try {
                decoded = decodeTitlePayload(titleRaw, nonce)
                failure = null
              } catch (error) {
                // A matched payload that fails to decode is definitive.
                decoded = undefined
                failure = error
                break
              }
              if (decoded !== undefined) break
              await sleep(60)
            }
          }
          const restoreTo = originalTitle
          await el.executeJavaScript(`document.title = ${JSON.stringify(restoreTo)}`, false).catch(() => {})
          if (diag) {
            diag.path = 'webview'
            diag.relay = relay
            diag.titleRawHead = typeof titleRaw === 'string' ? titleRaw.slice(0, 60) : String(titleRaw)
            diag.decodedType = typeof decoded
          }
          if (failure !== null) throw failure
          if (decoded === undefined) {
            throw new Error(
              `browser-bridge: title relay did not answer; diag=${JSON.stringify(diag ?? {})}`,
            )
          }
          return decoded
        })
      }
      const doc = safe(() => el.contentDocument)
      if (!doc) {
        throw new Error(
          'this page is cross-origin: the browser blocks the app from reading or controlling it inside an iframe. ' +
            'Open it in the DeepSeek Harness desktop app for full access.',
        )
      }
      if (diag) diag.path = 'iframe-eval'
      const win = doc.defaultView
      if (!win) throw new Error('iframe has no window')
      const run = async () => {
        let out
        try {
          out = win.eval(code)
        } catch (error) {
          throw new Error('page evaluation failed: ' + (error?.message ?? String(error)))
        }
        if (out && typeof out.then === 'function') out = await out
        return out
      }
      return await withFrameQueue(el, run)
    }

    // ── page-side code builders (evaluated inside the page) ────────────────

    const readCode = (maxChars) => `(async () => {
  const d = document
  const body = d.body
  const full = body && typeof body.innerText === 'string' ? body.innerText : ''
  const rawTitle = d.title || ''
  return {
    url: d.location ? String(d.location.href) : null,
    title: rawTitle.startsWith('__dshbb__') ? '' : rawTitle,
    text: full.slice(0, ${maxChars}),
    totalTextLength: full.length,
    readyState: d.readyState,
    scrollY: Math.round(scrollY || 0),
    scrollHeight: Math.round(((d.scrollingElement || d.documentElement) || {}).scrollHeight || 0),
    viewportHeight: Math.round(innerHeight || 0)
  }
})()`

    const clickCode = (selector, text) => `(async () => {
  let el = null
  ${selector ? `try { el = document.querySelector(${JSON.stringify(selector)}) } catch (e) { return { found: false, error: 'invalid selector: ' + e.message } }` : ''}
  if (!el && ${JSON.stringify(text ?? null)}) {
    const needle = ${JSON.stringify((text ?? '').toLowerCase())}
    const candidates = Array.from((document.body || document).querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,li,label,span,div,td,th,p,h1,h2,h3,h4,h5,h6'))
    let best = null
    let bestLength = Infinity
    for (const candidate of candidates) {
      if (candidate !== document.body && candidate.getClientRects().length === 0) continue
      const own = Array.from(candidate.childNodes).filter(function (n) { return n.nodeType === 3 }).map(function (n) { return n.textContent || '' }).join(' ').trim().toLowerCase()
      if (own && own.includes(needle) && own.length < bestLength) { best = candidate; bestLength = own.length }
    }
    el = best
  }
  if (!el) return { found: false }
  try { el.scrollIntoView({ block: 'center' }) } catch (e) {}
  let clickError = null
  try {
    if (typeof el.click === 'function') {
      el.click()
    } else {
      const r = el.getBoundingClientRect()
      const base = { bubbles: true, cancelable: true, composed: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 0 }
      const fire = function (type) {
        let ev
        try { ev = new PointerEvent(type, Object.assign({}, base, { pointerId: 1, pointerType: 'mouse', isPrimary: true })) }
        catch (e) { ev = new MouseEvent(type, base) }
        el.dispatchEvent(ev)
      }
      fire('pointerdown'); fire('mousedown'); fire('pointerup'); fire('mouseup')
      el.dispatchEvent(new MouseEvent('click', base))
    }
  } catch (e) { clickError = e && e.message ? e.message : String(e) }
  const rect = el.getBoundingClientRect()
  const out = { found: true, tag: el.tagName, id: el.id || undefined, text: (el.textContent || '').trim().slice(0, 120), rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } }
  if (clickError) out.error = 'click failed: ' + clickError
  return out
})()`

    const typeCode = (selector, text, clear, pressEnter) => `(async () => {
  let el = null
  try { el = document.querySelector(${JSON.stringify(selector)}) } catch (e) { return { found: false, error: 'invalid selector: ' + e.message } }
  if (!el) return { found: false }
  el.focus()
  const editable = el.isContentEditable === true
  const typable = editable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox','radio','button','submit','image','file','range'].includes(String(el.getAttribute('type') || 'text').toLowerCase()))
  if (!typable) return { found: true, tag: el.tagName, error: 'target has no text value (use browser_evaluate for custom widgets)' }
  if (editable) {
    try {
      const sel = getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
      if (${clear ? 'true' : 'false'}) document.execCommand('delete')
      document.execCommand('insertText', false, ${JSON.stringify(text)})
    } catch (e) {
      return { found: true, tag: el.tagName, error: 'insertText failed: ' + e.message }
    }
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    const current = typeof el.value === 'string' ? el.value : ''
    const next = (${clear ? 'true' : 'false'} ? '' : current) + ${JSON.stringify(text)}
    if (desc && desc.set) desc.set.call(el, next)
    else el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ${pressEnter ? `var keyInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
  el.dispatchEvent(new KeyboardEvent('keydown', keyInit))
  el.dispatchEvent(new KeyboardEvent('keypress', keyInit))
  el.dispatchEvent(new KeyboardEvent('keyup', keyInit))` : ''}
  return { found: true, tag: el.tagName, value: (editable ? (el.textContent || '') : String(el.value || '')).slice(0, 200) }
})()`

    const pressCode = (key) => `(async () => {
  const named = Object.assign(Object.create(null), {
    enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
    backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
    arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
    pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
    home: ['Home', 'Home', 36], end: ['End', 'End', 35], space: [' ', 'Space', 32]
  })
  const spec = named[${JSON.stringify(String(key).toLowerCase())}] || [${JSON.stringify(String(key))}, ${JSON.stringify(String(key))}, 0]
  const el = document.activeElement || document.body
  const make = function (extra) { return Object.assign({ bubbles: true, cancelable: true, key: spec[0], code: spec[1] }, extra) }
  el.dispatchEvent(new KeyboardEvent('keydown', make({ keyCode: spec[2], which: spec[2], charCode: 0 })))
  if (spec[0].length === 1 || spec[0] === 'Enter') {
    const charCode = spec[0].length === 1 ? spec[0].charCodeAt(0) : 13
    el.dispatchEvent(new KeyboardEvent('keypress', make({ keyCode: charCode, which: charCode, charCode: charCode })))
  }
  el.dispatchEvent(new KeyboardEvent('keyup', make({ keyCode: spec[2], which: spec[2], charCode: 0 })))
  return { dispatched: true, target: el.tagName }
})()`

    const scrollCode = (direction, amountPx, to) => `(async () => {
  const se = document.scrollingElement || document.documentElement
  ${to === 'top' ? 'se.scrollTop = 0' : to === 'bottom' ? 'se.scrollTop = se.scrollHeight' : `scrollBy(0, ${direction === 'up' ? -amountPx : amountPx})`}
  await new Promise(function (r) { setTimeout(r, 150) })
  return { scrollY: Math.round(scrollY || 0), scrollHeight: Math.round((se && se.scrollHeight) || 0) }
})()`

    const evaluateCode = (expression) => `(async () => { return (${expression}) })()`

    const screenshotFrame = async (el) => {
      if (kindOf(el) !== 'webview') {
        throw new Error('screenshot requires the desktop app: the Web build embeds pages in an iframe that cannot be captured')
      }
      if (typeof el.capturePage !== 'function') throw new Error('capturePage is not available on this webview')
      const image = await el.capturePage()
      if (image && typeof image.isEmpty === 'function' && image.isEmpty()) {
        throw new Error('capturePage returned an empty image — the tab is hidden; switch to it in the sidebar and retry')
      }
      if (image && typeof image.getSize === 'function') {
        const size = image.getSize()
        if (!size || size.width <= 1 || size.height <= 1) {
          throw new Error('capturePage returned a blank image — the tab is hidden; switch to it in the sidebar and retry')
        }
      }
      const dataUrl = image && typeof image.toDataURL === 'function' ? image.toDataURL() : null
      if (!dataUrl || dataUrl.length < 100) throw new Error('capturePage returned no usable image')
      return dataUrl
    }

    // ── command execution ──────────────────────────────────────────────────

    const runCommand = async (command) => {
      const args = command.args ?? {}
      switch (command.action) {
        case 'open': {
          const sidebar = ctxRef.sidebarRight
          if (!sidebar || typeof sidebar.openTab !== 'function') {
            throw new Error('sidebarRight service unavailable in this client build')
          }
          const target = String(args.url ?? '')
          await sidebar.openTab('browser', { params: { url: target } })
          let origin = null
          try { origin = new URL(target).origin } catch (e) { origin = null }
          const deadline = Date.now() + 4000
          let matched = null
          while (Date.now() < deadline && matched === null) {
            await sleep(250)
            const frames = describeFrames()
            matched = frames.find((frame) => origin !== null && frame.url !== null && frame.url.startsWith(origin)) ?? null
          }
          const frames = describeFrames().map((frame) => frame.id + '=' + (frame.url ?? '?'))
          const note = matched
            ? `New frame ${matched.id} is live at ${matched.url}.`
            : 'The new tab is queued; run browser_status in a moment to see it.'
          return { summary: `Opened ${target} in a new Sidebar Browser tab. ${note} Frames now: ${frames.join(', ') || '(none mounted)'}` }
        }
        case 'read': {
          const el = findFrame(command.frameId)
          const value = await evalInFrame(el, readCode(Math.max(200, Math.min(60000, Number(args.maxChars) || 12000))))
          return jsonSafe(value)
        }
        case 'evaluate': {
          const el = findFrame(command.frameId)
          const diag = {}
          const value = await evalInFrame(el, evaluateCode(String(args.expression ?? 'null')), diag)
          return { result: jsonSafe(value), diag }
        }
        case 'click': {
          const el = findFrame(command.frameId)
          return jsonSafe(await evalInFrame(el, clickCode(args.selector ?? null, args.text ?? null)))
        }
        case 'type': {
          const el = findFrame(command.frameId)
          return jsonSafe(await evalInFrame(el, typeCode(String(args.selector ?? ''), String(args.text ?? ''), args.clear !== false, args.pressEnter === true)))
        }
        case 'press': {
          const el = findFrame(command.frameId)
          return jsonSafe(await evalInFrame(el, pressCode(String(args.key ?? ''))))
        }
        case 'scroll': {
          const el = findFrame(command.frameId)
          return jsonSafe(await evalInFrame(el, scrollCode(args.direction === 'up' ? 'up' : 'down', Number(args.amountPx) || 600, args.to ?? null)))
        }
        case 'screenshot': {
          const el = findFrame(command.frameId)
          return { dataUrl: await screenshotFrame(el) }
        }
        default:
          throw new Error(`unknown bridge action "${command.action}"`)
      }
    }

    // ── host communication ─────────────────────────────────────────────────

    const post = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json().catch(() => undefined)
    }

    const warned = new Set()
    const warnOnce = (message) => {
      if (warned.has(message)) return
      warned.add(message)
      try { console.warn('browser-bridge:', message) } catch {}
    }

    const executeCommand = async (command) => {
      try {
        const value = await runCommand(command)
        await deliverResult(command.id, command.token, true, value)
      } catch (error) {
        await deliverResult(command.id, command.token, false, undefined, error instanceof Error ? error.message : String(error))
      }
    }

    /** Deliver a result with retries; on total failure send a tiny error so the host never waits blind. */
    const deliverResult = async (id, token, ok, value, error) => {
      const payload = ok ? { id, token, ok: true, value } : { id, token, ok: false, error: error ?? 'command failed' }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await post('/browser-bridge/result', payload)
          return
        } catch (deliveryError) {
          if (attempt === 2) {
            warnOnce('result delivery failed after retries: ' + (deliveryError?.message ?? deliveryError))
            await post('/browser-bridge/result', { id, token, ok: false, error: 'result delivery failed: ' + (deliveryError?.message ?? deliveryError) }).catch(() => {})
          } else {
            await sleep(250 * (attempt + 1))
          }
        }
      }
    }

    /** Set from apply(); keeps runCommand's sidebar access without a circular init. */
    let ctxRef = { sidebarRight: undefined }

    return {
      inject: ['sidebarRight'],
      apply(ctx) {
        ctxRef.sidebarRight = ctx.sidebarRight
        ctx.effect(
          () => {
            let stopped = false
            let timer
            const loop = async () => {
              if (stopped) return
              let frames = []
              try {
                frames = describeFrames()
                await post('/browser-bridge/state', { clientId, version: 4, platform, frames })
                const query = '/browser-bridge/poll?clientId=' + encodeURIComponent(clientId) + '&cursor=' + String(cursor)
                const response = await fetch(query, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
                if (response.ok) {
                  const body = await response.json().catch(() => undefined)
                  if (body && typeof body.cursor === 'number') cursor = body.cursor
                  const commands = Array.isArray(body?.commands) ? body.commands : []
                  for (const command of commands) {
                    if (command && typeof command.id === 'string' && typeof command.action === 'string' && typeof command.token === 'string') {
                      void executeCommand(command)
                    }
                  }
                }
              } catch (error) {
                warnOnce('bridge loop error: ' + (error instanceof Error ? error.message : String(error)))
              }
              if (!stopped) timer = setTimeout(loop, frames.length > 0 ? 400 : 1500)
            }
            void loop()
            return () => {
              stopped = true
              if (timer !== undefined) clearTimeout(timer)
            }
          },
          'browser-bridge: client loop',
        )
      },
    }
  },
})
