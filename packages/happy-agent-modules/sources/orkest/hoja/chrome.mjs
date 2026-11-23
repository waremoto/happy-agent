// Hoja chrome: the Notion-style block UI over any rendered document, in plain DOM.
//
// The host renders its blocks (Orkest's TipTap schema, Botanic's NoteMarkdown) and marks each top-level block element
// with `data-hoja-block="<index>"` (indices of parseBlocks). The chrome adds, in one fixed layer under <body>:
//   · a hover handle at the block's left: "+" (insert below) and "⋮⋮" (click: block menu; drag: move);
//   · the block menu, also on right-click (Shift+right-click keeps the browser's menu): turn into, duplicate, delete,
//     move, copy link / Markdown, section actions on headings, AI actions;
//   · a drop line while dragging; a heading drags its whole section;
//   · section collapse (toggle headings), shown as a fold pill, kept per doc in localStorage when it is available.
// On host elements it only sets attributes (hidden, data-hoja-*), never children, so React and Vue reconcile freely.
// Every decision is emitted to `onAction({ id, index, block, section, to })`; the host applies the text change.
import { sectionOf } from './blocks.mjs'
import { blockMenu, filterMenu, filterSlash, label } from './menus.mjs'

const SEL = '[data-hoja-block]'
const DRAG_PX = 4

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue
    if (k === 'class') n.className = v
    else n.setAttribute(k, v === true ? '' : String(v))
  }
  if (text !== undefined) n.textContent = text
  return n
}

function store(key) {
  try {
    const raw = key ? window.localStorage.getItem(`hoja:fold:${key}`) : null
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    return new Set()
  }
}
function save(key, set) {
  try {
    if (key) window.localStorage.setItem(`hoja:fold:${key}`, JSON.stringify([...set].slice(0, 200)))
  } catch { /* private window or blocked storage: collapse just is not remembered */ }
}

/** Copy text to the clipboard (falls back to a hidden textarea where the async API is missing). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = el('textarea', { 'aria-hidden': 'true', 'style': 'position:fixed;opacity:0' })
    t.value = text
    document.body.appendChild(t)
    t.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    t.remove()
    return ok
  }
}

/** A menu (block menu or slash menu) in the chrome layer. */
function createMenu(layer, { lang, ariaLabel, onPick, onClose, search = true, keepFocus = false }) {
  const root = el('div', { 'class': 'hoja-menu', 'role': 'menu', 'aria-label': ariaLabel, 'data-hoja-menu': '' })
  // A slash menu serves a field that keeps the caret: pointer presses must not move focus into the menu.
  if (keepFocus) root.addEventListener('pointerdown', (e) => e.preventDefault())
  if (keepFocus) root.addEventListener('mousedown', (e) => e.preventDefault())
  const input = search ? el('input', { 'class': 'hoja-menu-search', 'type': 'text', 'placeholder': label('search', lang), 'aria-label': label('search', lang) }) : null
  const list = el('div', { class: 'hoja-menu-list' })
  if (input) root.appendChild(input)
  root.appendChild(list)
  let groups = []
  let sub = null
  let active = 0
  const items = () => [...list.querySelectorAll('.hoja-menu-item:not([disabled])')]
  function focusItem(i) {
    const all = items()
    if (!all.length) return
    active = (i + all.length) % all.length
    all.forEach((b, k) => b.classList.toggle('is-active', k === active))
    if (!keepFocus && document.activeElement !== input) all[active].focus()
    all[active].scrollIntoView?.({ block: 'nearest' })
  }
  function item(it) {
    const b = el('button', {
      'type': 'button', 'class': `hoja-menu-item${it.danger ? ' is-danger' : ''}${it.ai ? ' is-ai' : ''}`, 'role': 'menuitem',
      'data-id': it.id, 'disabled': !!it.disabled, 'aria-haspopup': it.children ? 'menu' : null
    })
    b.appendChild(el('span', { class: 'hoja-menu-label' }, it.label))
    if (it.children) b.appendChild(el('span', { 'class': 'hoja-menu-more', 'aria-hidden': 'true' }, '›'))
    if (it.hint) b.appendChild(el('span', { class: 'hoja-menu-hint' }, it.hint))
    b.addEventListener('click', (e) => {
      e.preventDefault()
      if (it.children) openSub(b, it)
      else onPick(it)
    })
    if (it.children) b.addEventListener('pointerenter', () => openSub(b, it))
    else b.addEventListener('pointerenter', () => closeSub())
    return b
  }
  function closeSub() {
    sub?.remove()
    sub = null
  }
  function openSub(anchor, it) {
    if (sub?.dataset.parent === it.id) return
    closeSub()
    sub = el('div', { 'class': 'hoja-menu hoja-submenu', 'role': 'menu', 'aria-label': it.label, 'data-parent': it.id })
    for (const c of it.children) sub.appendChild(item(c))
    layer.appendChild(sub)
    const r = anchor.getBoundingClientRect()
    place(sub, r.right + 2, r.top - 4, r.left)
  }
  function render(query = '') {
    list.textContent = ''
    closeSub()
    if (query.trim()) {
      const hits = filterMenu(groups, query)
      if (!hits.length) list.appendChild(el('p', { class: 'hoja-menu-empty' }, label('noResults', lang)))
      for (const h of hits) list.appendChild(item({ ...h, label: h.parent ? `${h.parent} › ${h.label}` : h.label }))
    } else {
      groups.forEach((g, gi) => {
        if (gi) list.appendChild(el('div', { 'class': 'hoja-menu-sep', 'role': 'separator' }))
        if (g.label) list.appendChild(el('p', { class: 'hoja-menu-group' }, g.label))
        for (const it of g.items) list.appendChild(item(it))
      })
    }
    active = 0
    items().forEach((b, k) => b.classList.toggle('is-active', k === 0))
  }
  root.addEventListener('keydown', (e) => {
    const all = items()
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(active + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(active - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); all[active]?.click() }
    else if (e.key === 'ArrowRight') { const b = all[active]; if (b?.getAttribute('aria-haspopup')) { e.preventDefault(); b.click(); sub?.querySelector('.hoja-menu-item')?.focus() } }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); focusItem(active + (e.shiftKey ? -1 : 1)) }
  })
  input?.addEventListener('input', () => render(input.value))
  return {
    root,
    open(nextGroups, x, y) {
      groups = nextGroups
      if (input) input.value = ''
      render('')
      layer.appendChild(root)
      place(root, x, y)
      if (input) input.focus({ preventScroll: true })
      else if (!keepFocus) items()[0]?.focus({ preventScroll: true })
    },
    setGroups(nextGroups) { groups = nextGroups; render(input?.value ?? '') },
    move(delta) { focusItem(active + delta) },
    pickActive() { items()[active]?.click() },
    contains(node) { return root.contains(node) || !!sub?.contains(node) },
    close() { closeSub(); root.remove() },
    get isOpen() { return root.isConnected }
  }
}

/** Put a fixed element at (x, y), kept inside the viewport (flipped left of `flipX` when it would overflow). */
function place(node, x, y, flipX) {
  node.style.left = `${Math.max(4, x)}px`
  node.style.top = `${Math.max(4, y)}px`
  const r = node.getBoundingClientRect()
  const vw = window.innerWidth || document.documentElement.clientWidth || 1024
  const vh = window.innerHeight || document.documentElement.clientHeight || 768
  if (r.right > vw - 4) node.style.left = `${Math.max(4, (flipX ?? vw) - r.width - (flipX ? 2 : 4))}px`
  if (r.bottom > vh - 4) node.style.top = `${Math.max(4, vh - r.height - 4)}px`
}

/**
 * Attach the chrome to `container`. options:
 *   blocks()   → the current HojaBlock[] (indices match data-hoja-block)
 *   onAction(action) where action = { id, index, block, section, to }
 *   lang, canEdit, ai (AI action ids or false), docKey (remembers collapsed sections), menuExtra(block) → items,
 *   insert (show "+"; default canEdit)
 * Returns { refresh, openMenu(index, x, y), collapsed(), setOptions(partial), destroy }.
 */
export function attachChrome(container, options = {}) {
  let opts = { lang: 'en', canEdit: true, ai: false, docKey: '', insert: undefined, ...options }
  const layer = el('div', { 'class': 'hoja-layer', 'data-hoja-layer': '' })
  document.body.appendChild(layer)
  container.classList.add('hoja-host')
  const handle = el('div', { 'class': 'hoja-handle', 'data-hoja-handle': '', 'hidden': true })
  const plus = el('button', { 'type': 'button', 'class': 'hoja-handle-plus', 'aria-label': label('insertBelow', opts.lang), 'title': label('insertBelow', opts.lang) }, '+')
  const grip = el('button', { 'type': 'button', 'class': 'hoja-handle-grip', 'aria-label': label('blockMenu', opts.lang), 'title': label('dragHandle', opts.lang), 'aria-haspopup': 'menu' }, '⋮⋮')
  const fold = el('button', { 'type': 'button', 'class': 'hoja-handle-fold', 'aria-label': label('collapse', opts.lang), 'hidden': true }, '▾')
  handle.append(plus, grip, fold)
  layer.appendChild(handle)
  const line = el('div', { 'class': 'hoja-drop', 'hidden': true })
  layer.appendChild(line)
  const pills = el('div', { class: 'hoja-folds' })
  layer.appendChild(pills)
  const folded = store(opts.docKey)
  // Toggles are collapsed by default: what a viewer opened is remembered (0.3).
  const opened = store(opts.docKey && opts.docKey + ':open')
  let sel = null
  let current = null
  let menuIndex = null
  let drag = null
  let frame = 0
  let hideTimer = 0

  // A host whose DOM is owned by an editor (ProseMirror redraws any node whose attributes change) passes `mutate`
  // to wrap every attribute write the chrome makes on its nodes, and `tag` to (re)write `data-hoja-block` itself.
  const write = (fn) => (opts.mutate ? opts.mutate(fn) : fn())
  const blocks = () => (typeof opts.blocks === 'function' ? opts.blocks() : opts.blocks) ?? []
  const elOf = (i) => container.querySelector(`[data-hoja-block="${i}"]`)
  const indexOf = (node) => {
    const b = node?.closest?.(SEL)
    if (!b || !container.contains(b)) return null
    const i = Number(b.getAttribute('data-hoja-block'))
    return Number.isInteger(i) ? i : null
  }
  const docLike = () => ({ blocks: blocks() })
  const emit = (id, index, extra = {}) => {
    const block = blocks()[index] ?? null
    opts.onAction?.({ id, index, block, section: id.startsWith('section:') || id === 'ai:section-shorter', ...extra })
  }

  function showHandle(i) {
    const node = elOf(i)
    if (!node || node.hidden) { handle.hidden = true; current = null; return }
    current = i
    const r = node.getBoundingClientRect()
    const b = blocks()[i]
    plus.hidden = !(opts.insert ?? opts.canEdit)
    const heading = b?.kind === 'heading'
    fold.hidden = !heading
    if (heading) {
      const open = !folded.has(b.checksum)
      fold.textContent = open ? '▾' : '▸'
      fold.setAttribute('aria-label', label(open ? 'collapse' : 'expand', opts.lang))
      fold.setAttribute('aria-expanded', String(open))
    }
    handle.hidden = false
    const w = handle.offsetWidth || 44
    // First line of the block: align to its line box, not the whole block's middle.
    const lh = parseFloat(getComputedStyle(node).lineHeight) || 24
    handle.style.top = `${r.top + Math.max(0, (Math.min(lh, r.height) - 24) / 2)}px`
    handle.style.left = `${Math.max(2, r.left - w - 4)}px`
  }
  function hideSoon() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!menu.isOpen && !drag && !handle.matches(':hover')) { handle.hidden = true; current = null }
    }, 350)
  }

  const menu = createMenu(layer, {
    lang: opts.lang,
    ariaLabel: label('blockMenu', opts.lang),
    onPick(it) {
      const i = menuIndex
      closeMenu()
      if (i === null) return
      if (it.id === 'section:collapse' || it.id === 'section:expand') return toggleFold(i)
      emit(it.id, i)
    },
    onClose: () => closeMenu(true)
  })
  function menuFor(i) {
    const list = blocks()
    const b = list[i]
    const first = i === 0 || list[i - 1]?.kind === 'frontmatter'
    return blockMenu(b, {
      lang: opts.lang, canEdit: opts.canEdit, ai: opts.ai, sectionAi: opts.sectionAi !== false, collapsed: !!b && folded.has(b.checksum),
      first, last: i >= list.length - 1, extra: opts.menuExtra?.(b, i) ?? []
    })
  }
  function openMenu(i, x, y) {
    if (!blocks()[i]) return
    menuIndex = i
    write(() => elOf(i)?.setAttribute('data-hoja-selected', ''))
    menu.open(menuFor(i), x, y)
  }
  function closeMenu(refocus) {
    if (!menu.isOpen) return
    menu.close()
    if (menuIndex !== null) {
      const n = elOf(menuIndex)
      write(() => n?.removeAttribute('data-hoja-selected'))
      if (refocus) grip.focus({ preventScroll: true })
    }
    menuIndex = null
  }

  function toggleFold(i) {
    const b = blocks()[i]
    if (!b || b.kind !== 'heading') return
    if (folded.has(b.checksum)) folded.delete(b.checksum)
    else folded.add(b.checksum)
    save(opts.docKey, folded)
    refresh()
    if (current === i) showHandle(i)
    opts.onFold?.({ index: i, collapsed: folded.has(b.checksum) })
  }

  // --- Selection (Shift+click, Shift+↑↓, Ctrl+A) and toggles -------------------------------------------------
  const range = () => (sel ? [Math.min(sel.a, sel.f), Math.max(sel.a, sel.f)] : null)
  function select(a, f = a) { sel = a === null || a === undefined ? null : { a, f }; refresh(); opts.onSelect?.(range()) }
  const near = (i, d) => { for (let k = i + d; k >= 0 && k < blocks().length; k += d) { const n = elOf(k); if (n && !n.hidden) return k } return null }
  function toggleOpen(i, open) {
    const b = blocks()[i]
    if (b?.kind !== 'toggle') return
    if (open ?? !opened.has(b.checksum)) opened.add(b.checksum)
    else opened.delete(b.checksum)
    save(opts.docKey && opts.docKey + ':open', opened)
    refresh()
    opts.onFold?.({ index: i, collapsed: !opened.has(b.checksum) })
  }
  const onClick = (e) => {
    const i = indexOf(e.target)
    if (i === null) return
    if (e.target.closest('[data-hoja-toggle]')) { e.preventDefault(); e.stopPropagation(); return toggleOpen(i) }
    if (e.shiftKey && !e.target.closest('input,textarea,[contenteditable="true"]')) {
      e.preventDefault(); e.stopPropagation()
      select(sel ? sel.a : indexOf(document.activeElement) ?? i, i)
      elOf(i)?.focus?.()
    } else if (sel) select(null)
  }

  function refresh() {
    const list = blocks()
    const doc = docLike()
    const hide = new Set()
    const heads = []
    const r = range()
    for (const b of list) {
      if (b.kind === 'toggle' && b.close != null && !opened.has(b.checksum)) for (let k = b.index + 1; k < b.close; k++) hide.add(k)
      if (b.kind !== 'heading' || !folded.has(b.checksum)) continue
      const s = sectionOf(doc, b.index)
      if (s.last > s.first) heads.push({ index: b.index, count: s.last - s.first })
      for (let k = s.first + 1; k <= s.last; k++) hide.add(k)
    }
    write(() => {
      opts.tag?.()
      for (const node of container.querySelectorAll(SEL)) {
        const i = Number(node.getAttribute('data-hoja-block'))
        const should = hide.has(i)
        if (should && !node.hasAttribute('data-hoja-folded')) { node.setAttribute('data-hoja-folded', ''); node.hidden = true }
        else if (!should && node.hasAttribute('data-hoja-folded')) { node.removeAttribute('data-hoja-folded'); node.hidden = false }
        const b = list[i]
        const collapsed = b?.kind === 'heading' ? folded.has(b.checksum) : b?.kind === 'toggle' && !opened.has(b.checksum)
        if (node.hasAttribute('data-hoja-collapsed') !== collapsed) node.toggleAttribute('data-hoja-collapsed', collapsed)
        if (b?.kind === 'toggle' && node.getAttribute('aria-expanded') !== String(!collapsed)) node.setAttribute('aria-expanded', String(!collapsed))
        const on = !!r && i >= r[0] && i <= r[1]
        if (node.hasAttribute('data-hoja-selected') !== on) { node.toggleAttribute('data-hoja-selected', on); node.setAttribute('aria-selected', String(on)) }
      }
    })
    placePills(heads)
  }
  function placePills(heads = [...container.querySelectorAll('[data-hoja-collapsed]')].map(n => ({ index: Number(n.getAttribute('data-hoja-block')), count: null }))) {
    pills.textContent = ''
    for (const h of heads) {
      const node = elOf(h.index)
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (r.bottom < 0 || r.top > (window.innerHeight || 4000)) continue
      const p = el('button', { 'type': 'button', 'class': 'hoja-fold-pill', 'aria-label': label('expand', opts.lang), 'data-index': h.index }, h.count ? `▸ ${h.count}` : '▸')
      p.style.top = `${r.bottom + 2}px`
      p.style.left = `${r.left}px`
      p.addEventListener('click', () => toggleFold(h.index))
      pills.appendChild(p)
    }
  }

  // --- Drag -------------------------------------------------------------------------------------------------
  function dropTarget(y, from, section) {
    const list = blocks()
    const doc = docLike()
    const own = section ? sectionOf(doc, from) : { first: from, last: from }
    let to = list.length
    let lineY = null
    let lineX = null
    let width = null
    for (const b of list) {
      const node = elOf(b.index)
      if (!node || node.hidden) continue
      const r = node.getBoundingClientRect()
      if (y < r.top + r.height / 2) {
        to = b.index
        lineY = r.top - 3
        lineX = r.left
        width = r.width
        break
      }
      lineY = r.bottom + 2
      lineX = r.left
      width = r.width
    }
    // A section's own blocks are not a target; a drop into a collapsed section lands after it.
    if (to >= own.first && to <= own.last + 1) return { to: null, y: null }
    return { to, y: lineY, x: lineX, width }
  }
  function autoscroll(y) {
    let s = container
    while (s && s !== document.body && !(s.scrollHeight > s.clientHeight && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement
    const target = s && s !== document.body ? s : document.scrollingElement
    if (!target) return
    const r = target === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : target.getBoundingClientRect()
    if (y < r.top + 40) target.scrollTop -= 12
    else if (y > r.bottom - 40) target.scrollTop += 12
  }
  function onGripDown(e) {
    if (e.button !== 0 || current === null) return
    const b = blocks()[current]
    drag = { from: current, x: e.clientX, y: e.clientY, active: false, section: b?.kind === 'heading', to: null, pointer: e.pointerId }
    try { grip.setPointerCapture(e.pointerId) } catch { /* not supported in every environment */ }
  }
  function onGripMove(e) {
    if (!drag) return
    if (!drag.active) {
      if (!opts.canEdit || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return
      drag.active = true
      document.documentElement.classList.add('hoja-dragging')
      const own = drag.section ? sectionOf(docLike(), drag.from) : { first: drag.from, last: drag.from }
      write(() => { for (let k = own.first; k <= own.last; k++) elOf(k)?.setAttribute('data-hoja-drag-source', '') })
    }
    const t = dropTarget(e.clientY, drag.from, drag.section)
    drag.to = t.to
    line.hidden = t.to === null
    if (t.to !== null) {
      line.style.top = `${t.y}px`
      line.style.left = `${t.x}px`
      line.style.width = `${t.width}px`
    }
    autoscroll(e.clientY)
  }
  function endDrag() {
    document.documentElement.classList.remove('hoja-dragging')
    write(() => { for (const n of container.querySelectorAll('[data-hoja-drag-source]')) n.removeAttribute('data-hoja-drag-source') })
    line.hidden = true
  }
  function onGripUp(e) {
    if (!drag) return
    const d = drag
    drag = null
    try { grip.releasePointerCapture(d.pointer) } catch { /* ignore */ }
    if (d.active) {
      endDrag()
      if (d.to !== null) emit('move', d.from, { to: d.to, section: d.section })
      return
    }
    const r = grip.getBoundingClientRect()
    if (menu.isOpen && menuIndex === d.from) closeMenu()
    else openMenu(d.from, r.left, r.bottom + 4)
    e.preventDefault()
  }

  // --- Listeners --------------------------------------------------------------------------------------------
  const onOver = (e) => {
    if (drag?.active) return
    const i = indexOf(e.target)
    if (i === null) return
    clearTimeout(hideTimer)
    if (i !== current) showHandle(i)
  }
  const onLeave = () => hideSoon()
  const onContext = (e) => {
    if (e.shiftKey) return
    const i = indexOf(e.target)
    if (i === null) return
    // Keep the browser menu for links, form fields and a text selection the person made.
    if (e.target.closest('a[href],input,textarea,[contenteditable="true"]') || String(window.getSelection?.() ?? '').trim()) return
    e.preventDefault()
    openMenu(i, e.clientX, e.clientY)
  }
  const onKey = (e) => {
    const i = indexOf(e.target)
    if (i === null) return
    const editable = e.target.closest('input,textarea,[contenteditable="true"]')
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      const r = elOf(i).getBoundingClientRect()
      openMenu(i, r.left, r.top + 20)
    } else if (e.altKey && !editable && opts.canEdit && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      emit(e.key === 'ArrowUp' ? 'move-up' : 'move-down', i)
    } else if (!editable && !e.altKey) {
      const mod = e.ctrlKey || e.metaKey
      const r = range()
      const up = e.key === 'ArrowUp'
      if ((up || e.key === 'ArrowDown') && !mod) {
        const k = near(i, up ? -1 : 1)
        if (k === null) return
        e.preventDefault()
        if (e.shiftKey) select(sel ? sel.a : i, k)
        else if (sel) select(null)
        elOf(k).focus?.()
      } else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); select(0, blocks().length - 1) }
      else if (e.key === 'Escape' && sel) select(null)
      else if (e.key === 'Tab' && r && opts.canEdit) { e.preventDefault(); select(null); emit(e.shiftKey ? 'outdent' : 'indent', r[0], { first: r[0], last: r[1] }) }
      else if (e.key === '>' && !mod && opts.canEdit) { e.preventDefault(); emit('toggle', i) }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && blocks()[i]?.kind === 'toggle') { e.preventDefault(); toggleOpen(i, e.key === 'ArrowRight') }
    }
  }
  const onAway = (e) => {
    if (menu.isOpen && !menu.contains(e.target) && !handle.contains(e.target)) closeMenu()
  }
  const onScroll = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (current !== null && !handle.hidden) showHandle(current)
      placePills()
      if (menu.isOpen && menuIndex !== null) closeMenu()
    })
  }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; refresh(); if (current !== null) showHandle(current) })
  }) : null

  container.addEventListener('pointerover', onOver)
  container.addEventListener('pointerleave', onLeave)
  container.addEventListener('contextmenu', onContext)
  container.addEventListener('keydown', onKey)
  container.addEventListener('click', onClick, true)
  handle.addEventListener('pointerenter', () => clearTimeout(hideTimer))
  handle.addEventListener('pointerleave', onLeave)
  grip.addEventListener('pointerdown', onGripDown)
  grip.addEventListener('pointermove', onGripMove)
  grip.addEventListener('pointerup', onGripUp)
  grip.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && current !== null) {
      e.preventDefault()
      const r = grip.getBoundingClientRect()
      openMenu(current, r.left, r.bottom + 4)
    }
  })
  plus.addEventListener('click', () => { if (current !== null) emit('insert', current) })
  fold.addEventListener('click', () => { if (current !== null) toggleFold(current) })
  window.addEventListener('pointerdown', onAway, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  observer?.observe(container, { childList: true, subtree: true })
  refresh()

  return {
    refresh,
    openMenu,
    closeMenu: () => closeMenu(),
    toggleFold,
    toggleOpen,
    select,
    selection: range,
    collapsed: () => new Set(folded),
    setOptions(partial) {
      opts = { ...opts, ...partial }
      if (partial.docKey !== undefined) {
        folded.clear()
        for (const k of store(opts.docKey)) folded.add(k)
        opened.clear()
        for (const k of store(opts.docKey && opts.docKey + ':open')) opened.add(k)
        sel = null
      }
      refresh()
    },
    destroy() {
      cancelAnimationFrame(frame)
      clearTimeout(hideTimer)
      observer?.disconnect()
      container.removeEventListener('pointerover', onOver)
      container.removeEventListener('pointerleave', onLeave)
      container.removeEventListener('contextmenu', onContext)
      container.removeEventListener('keydown', onKey)
      container.removeEventListener('click', onClick, true)
      window.removeEventListener('pointerdown', onAway, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      if (drag?.active) endDrag()
      write(() => { for (const n of container.querySelectorAll('[data-hoja-folded]')) { n.hidden = false; n.removeAttribute('data-hoja-folded') } })
      container.classList.remove('hoja-host')
      layer.remove()
    }
  }
}

// --- Slash menu --------------------------------------------------------------------------------------------

/** Where the caret of a textarea is on screen (a mirror element measures it). */
export function caretRect(textarea) {
  const cs = getComputedStyle(textarea)
  const mirror = el('div', { 'aria-hidden': 'true' })
  for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'tabSize']) mirror.style[p] = cs[p]
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' })
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart)
  const mark = el('span', {}, '​')
  mirror.appendChild(mark)
  document.body.appendChild(mirror)
  const lh = parseFloat(cs.lineHeight) || 20
  const top = mark.offsetTop - textarea.scrollTop
  const left = mark.offsetLeft
  mirror.remove()
  const r = textarea.getBoundingClientRect()
  return { left: r.left + left, top: r.top + top, bottom: r.top + top + lh }
}

/** The "/query" a line consists of, or null. */
export function slashQuery(lineText) {
  const m = /^\s{0,3}\/([\p{L}\p{N}-]{0,24})$/u.exec(lineText)
  return m ? m[1] : null
}

/** Set a field's value so React's and Vue's listeners see it (the native setter, then an input event). */
export function setFieldValue(field, value) {
  const proto = Object.getPrototypeOf(field)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(field, value)
  else field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * A generic slash menu: the host tells it when the caret line is "/query" (`update(query, rect)`), and it calls
 * `onPick(item)` with a SLASH_ITEMS entry. Used directly by line editors (Orkest's room) and by attachSlash.
 */
export function createSlashMenu({ lang = 'en', items, onPick, onClose } = {}) {
  let layer = document.querySelector('[data-hoja-slash-layer]')
  if (!layer) {
    layer = el('div', { 'class': 'hoja-layer', 'data-hoja-slash-layer': '' })
    document.body.appendChild(layer)
  }
  const pool = items
  const menu = createMenu(layer, {
    lang, ariaLabel: label('slashMenu', lang), search: false, keepFocus: true,
    onPick: (it) => { menu.close(); onPick?.(it.item) },
    onClose: () => { menu.close(); onClose?.() }
  })
  return {
    update(query, rect) {
      if (query === null || query === undefined) { if (menu.isOpen) menu.close(); return }
      const hits = filterSlash(query, lang, pool ?? undefined).map(it => ({ id: it.id, label: label(it.id, lang), hint: it.icon, item: it }))
      const groups = hits.length ? [{ id: 'slash', items: hits }] : [{ id: 'none', items: [{ id: 'none', label: label('noResults', lang), disabled: true }] }]
      if (!menu.isOpen) menu.open(groups, rect.left, rect.bottom + 4)
      else menu.setGroups(groups)
    },
    /** Keyboard while open: true when the key was handled (the host then prevents its default). */
    key(e) {
      if (!menu.isOpen) return false
      if (e.key === 'ArrowDown') { menu.move(1); return true }
      if (e.key === 'ArrowUp') { menu.move(-1); return true }
      if (e.key === 'Enter' || e.key === 'Tab') { menu.pickActive(); return true }
      if (e.key === 'Escape') { menu.close(); onClose?.(); return true }
      return false
    },
    get isOpen() { return menu.isOpen },
    close() { menu.close() },
    destroy() { menu.close(); if (!layer.children.length) layer.remove() }
  }
}

/** The slash menu on a textarea: "/" alone on a line opens it; a pick replaces that line with the item's markdown. */
export function attachSlash(textarea, { lang = 'en', items } = {}) {
  let lineStart = 0
  let lineEnd = 0
  function caretLine() {
    const v = textarea.value
    const at = textarea.selectionStart
    lineStart = v.lastIndexOf('\n', at - 1) + 1
    const nl = v.indexOf('\n', at)
    lineEnd = nl < 0 ? v.length : nl
    return at === textarea.selectionEnd && at === lineEnd ? v.slice(lineStart, lineEnd) : null
  }
  const slash = createSlashMenu({
    lang, items,
    onPick(item) {
      const v = textarea.value
      const insert = item.lines.join('\n')
      setFieldValue(textarea, v.slice(0, lineStart) + insert + v.slice(lineEnd))
      const [cl, cc] = item.caret ?? [0, 0]
      const offset = item.lines.slice(0, cl).reduce((n, l) => n + l.length + 1, 0) + cc
      textarea.focus()
      textarea.setSelectionRange(lineStart + offset, lineStart + offset)
    }
  })
  const onInput = () => {
    const text = caretLine()
    const q = text === null ? null : slashQuery(text)
    void slash.update(q, q === null ? null : caretRect(textarea))
  }
  const onKey = (e) => { if (slash.key(e)) { e.preventDefault(); e.stopPropagation() } }
  const onBlur = () => setTimeout(() => { if (!document.activeElement?.closest?.('[data-hoja-menu]')) slash.close() }, 150)
  textarea.addEventListener('input', onInput)
  textarea.addEventListener('keydown', onKey, true)
  textarea.addEventListener('blur', onBlur)
  return {
    get isOpen() { return slash.isOpen },
    destroy() {
      textarea.removeEventListener('input', onInput)
      textarea.removeEventListener('keydown', onKey, true)
      textarea.removeEventListener('blur', onBlur)
      slash.destroy()
    }
  }
}
