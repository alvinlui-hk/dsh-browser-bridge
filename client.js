/**
 * Browser Bridge — Client half.
 *
 * Runs inside the DeepSeek Harness web GUI page. It finds the sidebar
 * browser's frame elements (`[data-sidebar-browser-frame]`: Electron
 * `<webview>` on Desktop, `<iframe>` on Web), reports their state to the Host
 * half, polls for commands, executes them against the frames, and answers.
 *
 * Desktop `<webview>` elements expose the full Electron embedder API from this
 * page (executeJavaScript / getURL / getTitle / capturePage), so read, act,
 * and screenshot all work there. Web `<iframe>` elements are scriptable only
 * when same-origin — the browser hard-blocks cross-origin frame access.
 */
window.__ModuleLoader__.load({
  id: '@alvinlui-hk/dsh-browser-bridge',
  factory(require) {
    const clientId = 'gui-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
    const platform = globalThis.dshDesktop?.protocolVersion === 1 ? 'desktop' : 'web'
    let cursor = 0

    const frameIds = new WeakMap()
    let frameSeq = 0

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
          base.url = typeof url === 'string' && url.length > 0 ? url : null
          const title = safe(() => (typeof el.getTitle === 'function' ? el.getTitle() : undefined))
          base.title = typeof title === 'string' && title.length > 0 ? title : null
          base.scriptable = typeof el.executeJavaScript === 'function'
        } else {
          const doc = safe(() => el.contentDocument)
          if (doc) {
            base.url = safe(() => (doc.location ? String(doc.location.href) : null)) ?? null
            base.title = typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : null
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
        return found
      }
      const visible = list.filter((el) => isVisible(el))
      return visible.length > 0 ? visible[visible.length - 1] : list[list.length - 1]
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

    // Some Electron builds relay webview executeJavaScript rejections but drop
    // resolved values (they arrive as undefined). getTitle()/getURL() still work
    // on those builds, so when a value does not come back directly we relay it
    // through the page's own <title> and read it from the embedder side.
    const TITLE_PREFIX = '__dshbb__:'

    const frameQueues = new WeakMap()

    /** Serialize commands targeting one frame so the title channel cannot interleave. */
    const withFrameQueue = (el, run) => {
      const tail = frameQueues.get(el) ?? Promise.resolve()
      const next = tail.then(run, run)
      frameQueues.set(el, next.catch(() => {}))
      return next
    }

    const encodeTitlePayload = (code) => `(async () => {
  const __value = await (${code})
  const __json = JSON.stringify(__value === undefined ? null : __value)
  const __bytes = new TextEncoder().encode(__json)
  let __bin = ''
  for (const __b of __bytes) __bin += String.fromCharCode(__b)
  const __payload = '${TITLE_PREFIX}' + btoa(__bin)
  document.title = __payload.length <= 480000 ? __payload : '${TITLE_PREFIX}ERR:' + encodeURIComponent('result too large for the title channel (page text > ~350KB); lower maxChars')
  return undefined
})()`

    const decodeTitlePayload = (raw) => {
      if (typeof raw !== 'string' || !raw.startsWith(TITLE_PREFIX)) return undefined
      const payload = raw.slice(TITLE_PREFIX.length)
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

    const evalInFrame = async (el, code, diag) => {
      const kind = kindOf(el)
      if (kind === 'webview') {
        if (typeof el.executeJavaScript !== 'function') {
          throw new Error('webview scripting is unavailable in this build')
        }
        return await withFrameQueue(el, async () => {
          let direct
          try {
            direct = await el.executeJavaScript(code, false)
          } catch (error) {
            // A rejected call is a definitive page error — relay it as-is.
            throw error instanceof Error ? error : new Error(String(error))
          }
          if (diag) {
            diag.path = 'webview'
            diag.directType = typeof direct
            if (typeof direct === 'string' || typeof direct === 'number') diag.directPreview = String(direct).slice(0, 60)
          }
          if (direct !== undefined && direct !== null) return direct
          // Value relay unavailable (or the script legitimately produced null):
          // re-run through the title channel to get a definitive answer.
          const originalTitle = typeof el.getTitle === 'function' ? el.getTitle() : undefined
          await el.executeJavaScript(encodeTitlePayload(code), false)
          let decoded
          let titleRaw
          const deadline = Date.now() + 2000
          for (;;) {
            titleRaw = typeof el.getTitle === 'function' ? el.getTitle() : undefined
            decoded = decodeTitlePayload(titleRaw)
            if (decoded !== undefined) break
            if (Date.now() > deadline) break
            await new Promise((resolve) => setTimeout(resolve, 60))
          }
          if (diag) {
            diag.titleChannelRan = true
            diag.decodedType = typeof decoded
            diag.titleRawHead = typeof titleRaw === 'string' ? titleRaw.slice(0, 60) : String(titleRaw)
            diag.decodedPreview = (() => {
              try {
                return JSON.stringify(decoded)?.slice(0, 60)
              } catch {
                return undefined
              }
            })()
          }
          if (typeof originalTitle === 'string' && originalTitle.length > 0) {
            void el.executeJavaScript(`document.title = ${JSON.stringify(originalTitle)}`, false).catch(() => {})
          }
          if (decoded === undefined) {
            // The value channel drops resolved payloads, but REJECTIONS always
            // get through — so diagnostics ride the error channel.
            throw new Error(
              `browser-bridge: title relay did not answer; diag=${JSON.stringify(diag)}`,
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
      let out
      try {
        out = win.eval(code)
      } catch (error) {
        throw new Error('page evaluation failed: ' + (error?.message ?? String(error)))
      }
      if (out && typeof out.then === 'function') out = await out
      return out
    }

    // ── page-side code builders (evaluated inside the page) ────────────────

    const readCode = (maxChars) => `(async () => {
  const d = document
  const body = d.body
  const full = body && typeof body.innerText === 'string' ? body.innerText : ''
  return {
    url: d.location ? String(d.location.href) : null,
    title: d.title || '',
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
      if (candidate !== document.body && !candidate.offsetParent) continue
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
      // SVGElement and other non-HTMLElement nodes have no .click(): fall back
      // to a full pointer/mouse event sequence at the element's center.
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
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return { found: false }
  el.focus()
  const editable = el.isContentEditable === true
  if (!editable && typeof el.value !== 'string' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
    return { found: true, tag: el.tagName, error: 'target has no text value (use browser_evaluate for custom widgets)' }
  }
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
    const proto = el.tagName === 'TEXTAREA' ? (el.constructor && HTMLTextAreaElement ? HTMLTextAreaElement.prototype : Object.getPrototypeOf(el)) : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    const current = typeof el.value === 'string' ? el.value : ''
    const next = (${clear ? 'true' : 'false'} ? '' : current) + ${JSON.stringify(text)}
    if (desc && desc.set) desc.set.call(el, next)
    else el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ${pressEnter ? `var keyInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
  el.dispatchEvent(new KeyboardEvent('keydown', keyInit))
  el.dispatchEvent(new KeyboardEvent('keyup', keyInit))` : ''}
  return { found: true, tag: el.tagName, value: (editable ? (el.textContent || '') : String(el.value || '')).slice(0, 200) }
})()`

    const pressCode = (key) => `(async () => {
  const named = {
    enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
    backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
    arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
    pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
    home: ['Home', 'Home', 36], end: ['End', 'End', 35], space: [' ', 'Space', 32]
  }
  const spec = named[${JSON.stringify(String(key).toLowerCase())}] || [${JSON.stringify(String(key))}, ${JSON.stringify(String(key))}, 0]
  const el = document.activeElement || document.body
  const make = function (extra) { return Object.assign({ bubbles: true, cancelable: true, key: spec[0], code: spec[1] }, extra) }
  el.dispatchEvent(new KeyboardEvent('keydown', make({ keyCode: spec[2], which: spec[2], charCode: 0 })))
  if (spec[0].length === 1) {
    const charCode = spec[0].charCodeAt(0)
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
      const dataUrl = image && typeof image.toDataURL === 'function' ? image.toDataURL() : null
      if (!dataUrl || dataUrl.length < 100) throw new Error('capturePage returned an empty image (is the tab visible?)')
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
          sidebar.openTab('browser', { params: { url: String(args.url ?? '') } })
          await new Promise((resolve) => setTimeout(resolve, 1200))
          const frames = describeFrames().map((frame) => frame.id + '=' + (frame.url ?? '?'))
          return {
            summary: `Opened ${String(args.url)} in a new Sidebar Browser tab. Frames now: ${frames.join(', ') || '(none mounted yet)'}`,
          }
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
          const value = await evalInFrame(el, clickCode(args.selector ?? null, args.text ?? null))
          if (value && value.found === false && args.selector && args.text) {
            const fallback = await evalInFrame(el, clickCode(null, args.text))
            return jsonSafe(fallback)
          }
          return jsonSafe(value)
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
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json().catch(() => undefined)
    }

    const executeCommand = async (command) => {
      try {
        const value = await runCommand(command)
        await post('/browser-bridge/result', { id: command.id, ok: true, value }).catch(() => {})
      } catch (error) {
        await post('/browser-bridge/result', {
          id: command.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
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
                await post('/browser-bridge/state', { clientId, version: 3, platform, frames })
                const query = '/browser-bridge/poll?clientId=' + encodeURIComponent(clientId) + '&cursor=' + String(cursor)
                const response = await fetch(query, { credentials: 'same-origin', cache: 'no-store' })
                if (response.ok) {
                  const body = await response.json().catch(() => undefined)
                  if (body && typeof body.cursor === 'number') cursor = body.cursor
                  const commands = Array.isArray(body?.commands) ? body.commands : []
                  for (const command of commands) {
                    if (command && typeof command.id === 'string' && typeof command.action === 'string') {
                      void executeCommand(command)
                    }
                  }
                }
              } catch {
                /* the host may be restarting; keep looping quietly */
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
