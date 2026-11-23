// Hoja's TipTap adapter (phase 4): the block under the caret becomes a small rich editor, loaded from that block's
// markdown; on blur only that block's line range is replaced (rich.mjs keeps every untouched line's bytes).
//
// TipTap stays the host's: the host passes its `Editor` class, its extensions (Orkest: its read schema without node
// views; Botanic: a lazily imported chunk) and `toHtml` (its own markdown renderer, html off). Hoja imports nothing.
// Blocks whose kind rich text cannot hold faithfully (callouts, HTML, frontmatter, diagrams, embeds) open as a plain
// textarea of their markdown instead; the write-back is the same.
import { parseDoc } from './blocks.mjs'
import { richEdit, richInsert, richKind } from './rich.mjs'

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)

/**
 * Open block `index` of `doc` for editing inside `element` (emptied first).
 *   Editor, extensions, toHtml   the host's TipTap and markdown renderer (rich blocks only)
 *   at        { left, top } of the click, to put the caret where the person pointed; else `caret` ('start' | 'end')
 *   insert    true: a NEW empty block below block `index` (-1: at the top); closing inserts what was typed
 *   current() the document's text NOW (the room may have moved on); the write-back is computed against it
 *   onClose(result, reason)  result: null (no change) | { text, edit, focus } | { conflict, lines }
 *                            reason: 'blur' | 'escape' | 'up' | 'down' | 'commit'
 * Returns { kind, editor?, textarea?, close(reason), destroy() }.
 */
export function openBlockEditor(options) {
  const { element, doc: input, index, at = null, caret = 'end', insert = false, current, onClose, Editor, extensions = [], toHtml, editorProps = {}, classes = '' } = options
  const doc = typeof input === 'string' ? parseDoc(input) : input
  const block = doc.blocks[index]
  if (!element || (!block && !(insert && index < 0))) return null
  const opened = block ? { index: block.index, checksum: block.checksum, start: block.start, end: block.end, lines: doc.lines.slice(block.start, block.end) } : null
  const markdown = insert ? '' : opened.lines.map(bare).join('\n')
  const kind = Editor && toHtml ? (insert ? 'rich' : richKind(block)) : 'source'
  const writeBack = (now, value) => (insert ? richInsert(now, opened, value) : richEdit(now, opened, value))
  let done = false
  let blurTimer = null
  element.replaceChildren()

  const finish = (reason, value) => {
    if (done) return
    done = true
    if (blurTimer) clearTimeout(blurTimer)
    let result = null
    try {
      result = writeBack(current ? current() : doc, value)
    } finally {
      api.destroy()
    }
    onClose?.(result, reason)
  }

  const onBlur = (read) => () => {
    if (blurTimer) clearTimeout(blurTimer)
    // Focus may move inside the editor (a table cell, a link); close only when it left the element.
    blurTimer = setTimeout(() => {
      const active = element.ownerDocument?.activeElement
      if (!active || !element.contains(active)) finish('blur', read())
    }, 0)
  }

  const api = { kind, block: opened, insert, close: () => {}, destroy: () => {} }

  if (kind === 'source') {
    const ta = element.ownerDocument.createElement('textarea')
    ta.className = `hoja-source-block ${classes}`.trim()
    ta.value = markdown
    ta.spellcheck = false
    ta.setAttribute('aria-label', 'Block source')
    const fit = () => {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight + 2}px`
    }
    const read = () => ({ lines: ta.value.replace(/\r\n?/g, '\n').split('\n') })
    const blur = onBlur(read)
    const key = (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        finish(e.key === 'Escape' ? 'escape' : 'commit', read())
      }
    }
    ta.addEventListener('input', fit)
    ta.addEventListener('blur', blur)
    ta.addEventListener('keydown', key)
    element.appendChild(ta)
    fit()
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    api.textarea = ta
    api.close = (reason = 'commit') => finish(reason, read())
    api.destroy = () => {
      ta.removeEventListener('input', fit)
      ta.removeEventListener('blur', blur)
      ta.removeEventListener('keydown', key)
      ta.remove()
    }
    return api
  }

  let editor = null
  const read = () => ({ before, after: editor ? editor.getJSON() : before })
  const atStart = (state) => state.selection.empty && state.selection.from <= 1 + firstOffset(state)
  const atEnd = (state) => state.selection.empty && state.selection.to >= state.doc.content.size - 1 - lastOffset(state)
  editor = new Editor({
    element,
    extensions,
    content: toHtml(markdown),
    editable: true,
    editorProps: {
      ...editorProps,
      attributes: { ...(editorProps.attributes ?? {}), 'class': `hoja-rich-block ${classes}`.trim(), 'data-hoja-rich': insert ? 'new' : block.kind },
      handleKeyDown: (view, e) => {
        if (editorProps.handleKeyDown?.(view, e)) return true
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          finish(e.key === 'Escape' ? 'escape' : 'commit', read())
          return true
        }
        if (e.key === 'ArrowUp' && !e.shiftKey && atStart(view.state)) {
          e.preventDefault()
          finish('up', read())
          return true
        }
        if (e.key === 'ArrowDown' && !e.shiftKey && atEnd(view.state)) {
          e.preventDefault()
          finish('down', read())
          return true
        }
        return false
      }
    }
  })
  trimCodeEnds(editor)
  const before = editor.getJSON()
  const blur = onBlur(read)
  editor.on('blur', blur)
  let pos = null
  if (at && editor.view?.posAtCoords) {
    try {
      pos = editor.view.posAtCoords(at)?.pos ?? null
    } catch { pos = null }
  }
  editor.commands.focus(pos ?? (caret === 'start' ? 'start' : 'end'))
  api.editor = editor
  api.close = (reason = 'commit') => finish(reason, read())
  api.destroy = () => {
    editor.off?.('blur', blur)
    editor.destroy()
    editor = null
  }
  return api
}

// A renderer ends a fence's code with "\n"; in the editor that is an empty last line the source does not have.
function trimCodeEnds(editor) {
  const { state } = editor
  if (!state?.doc?.descendants) return
  const cuts = []
  state.doc.descendants((node, pos) => {
    if (node.type?.name === 'codeBlock' && node.textContent.endsWith('\n')) cuts.push(pos + node.nodeSize - 2)
    return node.type?.name !== 'codeBlock'
  })
  if (!cuts.length) return
  let tr = state.tr
  for (const at of cuts.reverse()) tr = tr.delete(at, at + 1)
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}

// Arrow keys leave the block from its first or last text position (a heading, the first list item's text).
function firstOffset(state) {
  let depth = 0
  let node = state.doc.firstChild
  while (node && !node.isTextblock && node.firstChild) { depth++; node = node.firstChild }
  return depth
}
function lastOffset(state) {
  let depth = 0
  let node = state.doc.lastChild
  while (node && !node.isTextblock && node.lastChild) { depth++; node = node.lastChild }
  return depth
}
