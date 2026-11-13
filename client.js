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
    // Identity and frame numbering live on the page, not on this factory
    // instance. DSH disposes and re-applies the client plugin on its own
    // (observed after commands complete, and on every toggle), and a fresh
    // factory must keep the same client id and the same frame ids — otherwise
    // every id the caller is holding stops resolving.
    const PAGE_KEY = Symbol.for('dsh-browser-bridge.page')
    const page = globalThis[PAGE_KEY] ?? (globalThis[PAGE_KEY] = {
      clientId: 'gui-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36),
      frameSeq: 0,
      frameIds: new WeakMap(),
      // Frames whose capturePage hung after a focus switch. The webview stays
      // mounted and can report a real box, but Electron never composites it
      // again. Remember the element so the next screenshot fails immediately.
      uncapturable: new WeakSet(),
      // Only the newest factory instance may poll. A disposed instance's loop
      // sees a newer epoch and exits, so two loops never run at once.
      epoch: 0,
      // Set when the host routes 404. A dispose watchdog must not re-arm
      // after a deliberate disable; the next apply() clears it.
      hostGone: false,
    })
    // A page object created by an older client survives the toggle. Fill in
    // fields added after it was first created, or the new code crashes.
    page.uncapturable ??= new WeakSet()
    const clientId = page.clientId
    const platform = globalThis.dshDesktop?.protocolVersion === 1 ? 'desktop' : 'web'
    let cursor = 0
    let lastTargetFrameId = null

    // Frame execution queues are shared across plugin hot-reloads via a global
    // symbol, so a stale instance can never interleave with a fresh one.
    const FRAME_QUEUES_KEY = Symbol.for('dsh-browser-bridge.frameQueues')
    if (!globalThis[FRAME_QUEUES_KEY]) globalThis[FRAME_QUEUES_KEY] = new WeakMap()
    const frameQueues = globalThis[FRAME_QUEUES_KEY]

    const frameIds = page.frameIds

    const frameIdOf = (el) => {
      let id = frameIds.get(el)
      if (id === undefined) {
        page.frameSeq += 1
        id = 'frame-' + page.frameSeq
        frameIds.set(el, id)
      }
      return id
    }

    const isVisible = (el) => {
      if (!el.isConnected) return false
      const rects = el.getClientRects()
      if (rects.length === 0 || el.offsetWidth <= 0 || el.offsetHeight <= 0) return false
      // A hidden webview can still report its own box. Walk the ancestor chain:
      // display:none and visibility:hidden are the signals Electron's compositor
      // actually follows, and neither is visible on the webview rect itself.
      const view = el.ownerDocument?.defaultView
      for (let node = el; node instanceof Element; node = node.parentElement) {
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return false
        if (view && typeof view.getComputedStyle === 'function') {
          const style = view.getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        }
      }
      return true
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

    // HTML -> readable markdown, enough for articles and data pages: headings,
    // links, lists, tables, and JSON-LD blocks. Not a full renderer.
    const markdownCode = `(function () {
  var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 }
  var out = []
  var walk = function (node) {
    if (node.nodeType === 3) {
      var text = (node.textContent || '').replace(/\\s+/g, ' ')
      if (text.trim()) out.push(text)
      return
    }
    if (node.nodeType !== 1 || skip[node.tagName]) return
    var tag = node.tagName
    if (tag === 'BR') { out.push('\\n'); return }
    var heading = /^H([1-6])$/.exec(tag)
    if (heading) out.push('\\n\\n' + '#'.repeat(Number(heading[1])) + ' ')
    else if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'LI' || tag === 'TR') out.push('\\n')
    else if (tag === 'TD' || tag === 'TH') out.push(' | ')
    if (tag === 'LI') out.push('- ')
    if (tag === 'A') out.push('[')
    if (tag === 'TABLE') out.push('\\n')
    for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
    if (tag === 'A') {
      var href = node.getAttribute('href') || ''
      out.push('](' + href + ')')
    }
    if (heading || tag === 'P' || tag === 'TR' || tag === 'TABLE') out.push('\\n')
  }
  if (document.body) walk(document.body)
  var md = out.join('').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
  var ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(function (s) { return (s.textContent || '').trim() }).filter(Boolean)
  if (ld.length) md += '\\n\\n## JSON-LD\\n\\n' + ld.map(function (b) { return '\`\`\`json\\n' + b.slice(0, 4000) + '\\n\`\`\`' }).join('\\n\\n')
  return md
})()`

    const htmlCode = `(function () {
  var root = document.documentElement
  if (!root) return ''
  var clone = root.cloneNode(true)
  Array.from(clone.querySelectorAll('script, style, noscript, svg')).forEach(function (n) { n.remove() })
  return clone.outerHTML
})()`

    const readCode = (maxChars, mode) => `(async () => {
  const d = document
  const body = d.body
  const full = body && typeof body.innerText === 'string' ? body.innerText : ''
  const rawTitle = d.title || ''
  const mode = ${JSON.stringify(mode)}
  let content = full
  if (mode === 'markdown') content = ${markdownCode}
  else if (mode === 'html') content = ${htmlCode}
  return {
    url: d.location ? String(d.location.href) : null,
    title: rawTitle.startsWith('__dshbb__') ? '' : rawTitle,
    text: String(content == null ? '' : content).slice(0, ${maxChars}),
    totalTextLength: String(content == null ? '' : content).length,
    readyState: d.readyState,
    scrollY: Math.round(scrollY || 0),
    scrollHeight: Math.round(((d.scrollingElement || d.documentElement) || {}).scrollHeight || 0),
    viewportHeight: Math.round(innerHeight || 0)
  }
})()`

    const clickCode = (selector, text, index, x, y) => `(async () => {
  let el = null
  const index = ${Number.isInteger(index) ? index : 'null'}
  const point = ${x !== null && y !== null ? `{ x: ${x}, y: ${y} }` : 'null'}
  if (point) {
    el = document.elementFromPoint(point.x, point.y)
    if (!el) return { found: false, error: 'no element at ' + point.x + ',' + point.y }
  }
  ${selector ? `if (!el) { try { const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)})); el = index === null ? all[0] : all[index]; if (!el && index !== null) return { found: false, error: 'selector matched ' + all.length + ' element(s); index ' + index + ' is out of range' } } catch (e) { return { found: false, error: 'invalid selector: ' + e.message } } }` : ''}
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
  const tag = el.tagName
  const editable = el.isContentEditable === true
  const inputType = String(el.getAttribute('type') || 'text').toLowerCase()
  const typable = editable || tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox','radio','button','submit','reset','image','file','range','color','hidden'].includes(inputType))
  if (!typable) return { found: false, tag: tag, error: 'target has no text value (use browser_click for buttons, browser_evaluate for custom widgets)' }
  el.focus()
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
  const written = editable ? (el.textContent || '') : String(el.value || '')
  if (!written.includes(${JSON.stringify(text)})) return { found: true, tag: el.tagName, error: 'typed, but the value did not change (the page may have rejected the input)' }
  return { found: true, tag: el.tagName, value: written.slice(0, 200) }
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

    const waitCode = (selector, urlIncludes, textIncludes) => `(async () => {
  const d = document
  const rawTitle = d.title || ''
  const selector = ${JSON.stringify(selector)}
  const urlIncludes = ${JSON.stringify(urlIncludes)}
  const textIncludes = ${JSON.stringify(textIncludes)}
  const href = d.location ? String(d.location.href) : ''
  const bodyText = d.body && typeof d.body.innerText === 'string' ? d.body.innerText : ''
  let matched = 0
  let selectorError = null
  if (selector) {
    try { matched = d.querySelectorAll(selector).length } catch (e) { selectorError = e && e.message ? e.message : String(e) }
  }
  const urlOk = !urlIncludes || href.includes(urlIncludes)
  const textOk = !textIncludes || bodyText.includes(textIncludes)
  const selectorOk = !selector || matched > 0
  return {
    matched: selector ? selectorOk && urlOk && textOk : urlOk && textOk,
    matchCount: matched,
    url: href || null,
    title: rawTitle.startsWith('__dshbb__') ? '' : rawTitle,
    readyState: d.readyState,
    ...(selectorError ? { error: 'invalid selector: ' + selectorError } : {})
  }
})()`

    // Compile-check first so a statement or a thrown error comes back as the
    // page's own message instead of Electron's generic "Script failed to
    // execute" wrapper, which hides the real reason.
    const evaluateCode = (expression) => `(async () => {
  try { const AsyncFn = (async function () {}).constructor; new AsyncFn('return (' + ${JSON.stringify(expression)} + ')') } catch (e) {
    return { __dshbbError: 'expression must be a value, not a statement (' + (e && e.message ? e.message : e) + '). Wrap statements in an IIFE: (() => { ...; return value })()' }
  }
  try { return await (${expression}) } catch (e) {
    return { __dshbbError: 'page threw: ' + (e && e.message ? e.message : String(e)) }
  }
})()`

    const vizError = (error) => /UnknownVizError|ERR_ABORTED|not attached/i.test(error instanceof Error ? error.message : String(error))

    const screenshotFrame = async (el) => {
      if (kindOf(el) !== 'webview') {
        throw new Error('screenshot requires the desktop app: the Web build embeds pages in an iframe that cannot be captured')
      }
      if (typeof el.capturePage !== 'function') throw new Error('capturePage is not available on this webview')
      // Electron only composites the webview that is actually painted. A hidden
      // tab can still report a box, and a tab brought forward by focus can stay
      // uncapturable afterwards. Fail on either without touching the GUI.
      if (page.uncapturable.has(el)) {
        throw new Error('screenshot cannot capture this tab: a previous capturePage never settled after the tab was focused. Open a fresh tab with browser_open instead of retrying this frame')
      }
      if (!isVisible(el)) {
        throw new Error('screenshot needs the tab on screen. This tab is hidden (an ancestor is display:none or visibility:hidden). Switch to it in the right Sidebar and retry; background tabs are not focused automatically')
      }
      return await captureVisible(el)
    }

    const captureVisible = async (el) => {
      const capture = () => Promise.race([
        el.capturePage().catch((error) => {
          if (vizError(error)) {
            throw new Error('capturePage failed because the tab is not on screen (Electron compositor). Switch to the tab in the right Sidebar — do not minimize the window — and retry')
          }
          throw error
        }),
        sleep(4000).then(() => {
          page.uncapturable.add(el)
          throw new Error('capturePage did not settle in 4s. This tab is not being composited; open a fresh tab with browser_open instead of retrying this frame')
        }),
      ])
      let image = await capture()
      if (image && typeof image.isEmpty === 'function' && image.isEmpty()) {
        await sleep(800)
        image = await capture()
      }
      if (image && typeof image.isEmpty === 'function' && image.isEmpty()) {
        throw new Error('capturePage returned an empty image — the tab is hidden or the window is minimized; switch to it in the sidebar and retry')
      }
      if (image && typeof image.getSize === 'function') {
        const size = image.getSize()
        if (!size || size.width <= 1 || size.height <= 1) {
          throw new Error('capturePage returned a blank image — the tab is hidden or the window is minimized; switch to it in the sidebar and retry')
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
          const before = new Set(frameElements().map((el) => frameIdOf(el)))
          // openTab has been observed to never settle even after the tab exists.
          // The new frame is the success signal; the promise is only a bound so
          // a hang cannot pin this command until the host times out.
          let settled = false
          let openError = null
          const opened = Promise.resolve(sidebar.openTab('browser', { params: { url: target } })).then(
            (value) => {
              settled = true
              return value
            },
            (error) => {
              settled = true
              openError = error instanceof Error ? error : new Error(String(error))
              throw openError
            },
          )
          opened.catch(() => {})
          const appeared = (async () => {
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
              if (frameElements().some((el) => !before.has(frameIdOf(el)))) return true
              if (openError) throw openError
              await sleep(200)
            }
            return false
          })()
          const tabReady = await Promise.race([
            opened.then(() => true, () => false),
            appeared,
          ])
          if (!tabReady && !frameElements().some((el) => !before.has(frameIdOf(el)))) {
            if (openError) throw openError
            if (!settled) throw new Error('sidebar openTab did not settle within 8s and no new tab appeared')
          }
          let origin = null
          try { origin = new URL(target).origin } catch (e) { origin = null }
          const deadline = Date.now() + 4000
          let matched = null
          while (Date.now() < deadline) {
            await sleep(250)
            const fresh = describeFrames().filter((frame) => !before.has(frame.id))
            matched = fresh.find((frame) => origin !== null && frame.url !== null && frame.url.startsWith(origin))
              ?? fresh.find((frame) => frame.url !== null && !frame.url.startsWith('about:'))
              ?? null
            if (matched !== null) break
            if (fresh.length > 0 && Date.now() > deadline - 300) {
              matched = fresh[fresh.length - 1]
              break
            }
          }
          return {
            summary: matched
              ? `Opened ${target} in a new Sidebar Browser tab (frame id ${matched.id}).`
              : `Opened ${target}; the tab is queued — run browser_status in a moment for its frame id.`,
            ...(matched ? { frameId: matched.id, url: matched.url } : {}),
          }
        }
        case 'read': {
          const el = findFrame(command.frameId)
          const mode = args.mode === 'markdown' || args.mode === 'html' ? args.mode : 'text'
          const value = await evalInFrame(el, readCode(Math.max(200, Math.min(60000, Number(args.maxChars) || 12000)), mode))
          return jsonSafe(value)
        }
        case 'evaluate': {
          const el = findFrame(command.frameId)
          const expression = String(args.expression ?? 'null')
          // Reject statements before they reach the guest: a statement makes the
          // generated snippet fail to parse, and Electron then reports only the
          // generic "Script failed to execute", hiding the real reason.
          try {
            const AsyncFunction = (async function () {}).constructor
            new AsyncFunction('return (' + expression + ')')
          } catch (error) {
            throw new Error(
              'expression must be a value, not a statement (' +
                (error instanceof Error ? error.message : String(error)) +
                '). Wrap statements in an IIFE: (() => { ...; return value })()',
            )
          }
          const value = await evalInFrame(el, evaluateCode(expression))
          if (value && typeof value === 'object' && typeof value.__dshbbError === 'string') {
            throw new Error(value.__dshbbError)
          }
          return { result: jsonSafe(value) }
        }
        case 'click': {
          const el = findFrame(command.frameId)
          const index = Number.isInteger(args.index) ? args.index : null
          const x = Number.isFinite(args.x) ? Math.round(args.x) : null
          const y = Number.isFinite(args.y) ? Math.round(args.y) : null
          return jsonSafe(await evalInFrame(el, clickCode(args.selector ?? null, args.text ?? null, index, x, y)))
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
        case 'wait': {
          const el = findFrame(command.frameId)
          const timeoutMs = Math.max(500, Math.min(30_000, Number(args.timeoutMs) || 10_000))
          const selector = typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : null
          const urlIncludes = typeof args.urlIncludes === 'string' && args.urlIncludes.length > 0 ? args.urlIncludes : null
          const textIncludes = typeof args.textIncludes === 'string' && args.textIncludes.length > 0 ? args.textIncludes : null
          const deadline = Date.now() + timeoutMs
          let last = null
          while (Date.now() < deadline) {
            last = jsonSafe(await evalInFrame(el, waitCode(selector, urlIncludes, textIncludes)))
            if (last && last.error) throw new Error(last.error)
            if (last && last.matched === true) return { ...last, waitedMs: timeoutMs - (deadline - Date.now()) }
            await sleep(250)
          }
          return { ...(last ?? {}), matched: false, timedOut: true }
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
        // A new apply means the plugin is enabled again.
        page.hostGone = false
        // The poll loop must outlive this effect. DSH disposes client plugin
        // effects on its own — observed right after a command finishes — and
        // the page then reports nothing until someone toggles the plugin. A
        // disposed cleanup used to set `stopped` and the loop died with it.
        // The loop is owned by the page instead. Dispose clears the timer;
        // a watchdog re-arms it unless a newer factory instance has applied
        // (epoch bumped) or the host routes are gone (deliberate disable).
        const LOOP_KEY = Symbol.for('dsh-browser-bridge.loop')
        const myEpoch = ++page.epoch
        const stopLoop = (state, message) => {
          state.alive = false
          if (state.timer !== undefined) clearTimeout(state.timer)
          if (globalThis[LOOP_KEY] === state) delete globalThis[LOOP_KEY]
          if (message) warnOnce(message)
        }
        const startLoop = () => {
          if (page.hostGone || page.epoch !== myEpoch) return
          const running = globalThis[LOOP_KEY]
          if (running && running.epoch === myEpoch && running.alive) return
          // generation changes on every (re)arm, so a loop iteration that was
          // already awaiting when dispose cleared its timer cannot schedule
          // another tick afterwards.
          const generation = (running?.generation ?? 0) + 1
          const state = { epoch: myEpoch, generation, timer: undefined, alive: true }
          globalThis[LOOP_KEY] = state
          const loop = async () => {
            if (page.epoch !== myEpoch || globalThis[LOOP_KEY] !== state) return
            let frames = []
            let stoppedByHost = false
            try {
              frames = describeFrames()
              await post('/browser-bridge/state', { clientId, version: 8, platform, frames })
              const query = '/browser-bridge/poll?clientId=' + encodeURIComponent(clientId) + '&cursor=' + String(cursor)
              const response = await fetch(query, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
              // 404 means the host plugin was disabled and its routes are
              // gone. Stop until a newer apply() (toggle back on) takes over;
              // do not keep polling a dead host.
              if (response.status === 404) {
                stoppedByHost = true
              } else if (response.ok) {
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
              const message = error instanceof Error ? error.message : String(error)
              if (message === 'HTTP 404') stoppedByHost = true
              else warnOnce('bridge loop error: ' + message)
            }
            if (stoppedByHost) {
              page.hostGone = true
              stopLoop(state, 'host routes gone; poll loop stopped until the plugin is enabled again')
              return
            }
            if (page.epoch !== myEpoch || globalThis[LOOP_KEY] !== state || !state.alive) return
            state.timer = setTimeout(loop, frames.length > 0 ? 400 : 1500)
          }
          void loop()
          // A command (screenshot, wait, open) can outlive several poll beats.
          // The next beat must not wait for that command, or the host marks the
          // client stale and every later tool reports "no GUI page".
          const beat = setInterval(() => {
            if (page.epoch !== myEpoch || globalThis[LOOP_KEY] !== state || !state.alive || page.hostGone) {
              clearInterval(beat)
              return
            }
            post('/browser-bridge/state', {
              clientId,
              version: 8,
              platform,
              frames: safe(() => describeFrames()) ?? [],
            }).catch(() => {})
          }, 1500)
          state.beat = beat
        }
        ctx.effect(
          () => {
            startLoop()
            return () => {
              const running = globalThis[LOOP_KEY]
              if (running) {
                running.alive = false
                if (running.timer !== undefined) clearTimeout(running.timer)
                if (running.beat !== undefined) clearInterval(running.beat)
              }
              if (globalThis[LOOP_KEY] === running) delete globalThis[LOOP_KEY]
              // Re-arm unless a newer instance already owns the page, or the
              // host routes already 404'd (deliberate disable). startLoop
              // no-ops in both cases.
              setTimeout(() => {
                if (page.epoch === myEpoch) startLoop()
              }, 400)
            }
          },
          'browser-bridge: client loop',
        )
      },
    }
  },
})
