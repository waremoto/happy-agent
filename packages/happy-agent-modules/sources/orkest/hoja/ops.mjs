// Hoja operations. Every operation returns { text, edit, focus }:
//   text  — the whole new source;
//   edit  — the one line range it replaced: { from, to (exclusive, in the OLD lines), lines (the new lines) }, minimal
//           (common prefix and suffix removed), so a line room can apply it as one transaction and git sees exactly it;
//   focus — the index of the block to focus afterwards in the NEW doc (or null).
// Lines outside `edit` keep their bytes. That is the rule the whole component rests on (design § 2, Orkest D-15).
import { parseDoc, sectionOf } from './blocks.mjs'

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)
const isBlank = (line) => !bare(line).trim()

/** The minimal single range turning `a` into `b`. */
export function diffEdit(a, b) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { from: p, to: a.length - s, lines: b.slice(p, b.length - s) }
}

/** Apply an edit to lines (the inverse check of diffEdit). */
export function applyEdit(lines, edit) {
  return [...lines.slice(0, edit.from), ...edit.lines, ...lines.slice(edit.to)]
}

function result(doc, next, focusLine) {
  const edit = diffEdit(doc.lines, next)
  const text = next.join('\n')
  let focus = null
  if (focusLine !== null && focusLine !== undefined) {
    const after = parseDoc(text)
    const hit = after.blocks.find(b => focusLine >= b.start && focusLine < b.end) ?? after.blocks.find(b => b.start >= focusLine)
    focus = hit ? hit.index : null
  }
  return { text, edit, focus }
}

const docOf = (input) => (typeof input === 'string' ? parseDoc(input) : input)
/** New lines in the doc's own line ending. */
const withEol = (doc, lines) => (doc.eol === '\r\n' ? lines.map(l => (l.endsWith('\r') ? l : `${l}\r`)) : lines.map(bare))
const blankLine = (doc) => (doc.eol === '\r\n' ? '\r' : '')

/** The line range a block or its section covers. */
function span(doc, index, section) {
  if (section || doc.blocks[index]?.kind === 'toggle') {
    const s = sectionOf(doc, index)
    return s && { start: s.start, end: s.end, first: s.first, last: s.last }
  }
  const b = doc.blocks[index]
  return b && { start: b.start, end: b.end, first: index, last: index }
}

/**
 * Cut lines [start, end) and the blank lines that separated them from the next block (or, at the end of the doc, from
 * the previous one), so removing never leaves a double gap.
 */
function cut(lines, start, end) {
  let s = start
  let e = end
  while (e < lines.length && isBlank(lines[e])) e++
  if (e === lines.length) while (s > 0 && isBlank(lines[s - 1])) s--
  // Keep the file's trailing newline: if we ate the final empty line, put one back.
  const out = [...lines.slice(0, s), ...lines.slice(e)]
  if (lines.length && lines[lines.length - 1] === '' && out[out.length - 1] !== '' && e === lines.length) out.push('')
  return out
}

/** Replace a block's lines with `markdown` (several blocks allowed). Empty markdown removes the block. */
export function replaceBlock(input, index, markdown) {
  const doc = docOf(input)
  const b = doc.blocks[index]
  const next = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '')
  if (!b) return insertBlock(doc, doc.blocks.length - 1, next)
  if (!next) return removeBlock(doc, index)
  const lines = [...doc.lines.slice(0, b.start), ...withEol(doc, next.split('\n')), ...doc.lines.slice(b.end)]
  return result(doc, lines, b.start)
}

/** Insert markdown as new block(s) after block `after` (-1: at the top, after any frontmatter). */
export function insertBlock(input, after, markdown) {
  const doc = docOf(input)
  const body = withEol(doc, String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '').split('\n'))
  const fm = doc.blocks[0]?.kind === 'frontmatter' ? doc.blocks[0] : null
  const prev = after >= 0 && doc.blocks.length ? doc.blocks[Math.min(after, doc.blocks.length - 1)] : fm
  const at = prev ? prev.end : 0
  const before = doc.lines.slice(0, at)
  const after_ = doc.lines.slice(at)
  let k = 0
  while (k < after_.length && isBlank(after_[k])) k++
  // The gap after the previous block stays where it was, now between the new block and the next one.
  const gap = after_.slice(0, k)
  const tail = after_.slice(k)
  const lines = prev
    ? [...before, blankLine(doc), ...body, ...(tail.length && !gap.length ? [blankLine(doc)] : gap), ...tail]
    : [...body, ...(tail.length ? [blankLine(doc), ...tail] : gap.length ? gap : [''])]
  return result(doc, lines, before.length + (prev ? 1 : 0))
}

/** Remove a block (or the section a heading opens, with `section`). */
export function removeBlock(input, index, { section = false } = {}) {
  const doc = docOf(input)
  const r = span(doc, index, section)
  if (!r) return result(doc, doc.lines, null)
  return result(doc, cut(doc.lines, r.start, r.end), r.start)
}

/** Duplicate a block (or a section) right after itself. */
export function duplicateBlock(input, index, { section = false } = {}) {
  const doc = docOf(input)
  const r = span(doc, index, section)
  if (!r) return result(doc, doc.lines, null)
  const copy = doc.lines.slice(r.start, r.end)
  const lines = [...doc.lines.slice(0, r.end), blankLine(doc), ...copy, ...doc.lines.slice(r.end)]
  if (r.end < doc.lines.length && !isBlank(doc.lines[r.end])) lines.splice(r.end + 1 + copy.length, 0, blankLine(doc))
  return result(doc, lines, r.end + 1)
}

/**
 * Move a block (or a section) so it lands before block `to` (doc.blocks.length: at the end). A move into its own
 * range is a no-op. The moved lines and every other line keep their bytes.
 */
export function moveBlock(input, from, to, { section = false } = {}) {
  const doc = docOf(input)
  const r = span(doc, from, section)
  if (to === 0 && doc.blocks[0]?.kind === 'frontmatter') to = 1
  if (!r || to < 0 || to > doc.blocks.length || (to >= r.first && to <= r.last + 1)) return result(doc, doc.lines, r ? r.start : null)
  const moved = doc.lines.slice(r.start, r.end)
  const target = to < doc.blocks.length ? doc.blocks[to].start : null
  const rest = cut(doc.lines, r.start, r.end)
  // Where the target block starts once the moved lines are gone.
  let at
  if (target === null) {
    at = rest.length
    while (at > 0 && isBlank(rest[at - 1])) at--
    const trailing = rest.slice(at)
    const head = rest.slice(0, at)
    const lines = [...head, ...(head.length ? [blankLine(doc)] : []), ...moved, ...(trailing.length ? trailing : [])]
    return result(doc, lines, head.length + (head.length ? 1 : 0))
  }
  const removed = (r.start < target) ? doc.lines.length - rest.length : 0
  at = target - removed
  const lines = [...rest.slice(0, at), ...moved, blankLine(doc), ...rest.slice(at)]
  return result(doc, lines, at)
}

/** Move one step up or down among blocks (a heading with `section` jumps over whole sibling sections). */
export function nudgeBlock(input, index, direction, { section = false } = {}) {
  const doc = docOf(input)
  const r = span(doc, index, section)
  if (!r) return result(doc, doc.lines, null)
  if (direction < 0) {
    if (r.first === 0 || doc.blocks[r.first - 1].kind === 'frontmatter') return result(doc, doc.lines, r.start)
    let to = r.first - 1
    if (section && doc.blocks[index].kind === 'heading') {
      // Jump over the previous sibling section: back to the nearest heading of the same or a higher level.
      const level = doc.blocks[index].level
      while (to > 0 && !(doc.blocks[to].kind === 'heading' && doc.blocks[to].level <= level)) to--
    }
    return moveBlock(doc, index, to, { section })
  }
  if (r.last >= doc.blocks.length - 1) return result(doc, doc.lines, r.start)
  let to = r.last + 2
  if (section && doc.blocks[index].kind === 'heading') {
    const next = sectionOf(doc, r.last + 1)
    to = next.last + 1
  }
  return moveBlock(doc, index, Math.min(to, doc.blocks.length), { section })
}

// --- Turn into -----------------------------------------------------------------------------------------------

const LIST = /^\s{0,3}(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/
const LIST_KINDS = new Set(['bullet', 'ordered', 'task', 'quote', 'callout'])

/** A block's content lines with its markers stripped (heading #, quote >, callout tag, list and task markers). */
export function plainLines(lines, kind) {
  let body = lines.map(bare)
  if (kind === 'code' || kind === 'mermaid') {
    return body.slice(1, body.length > 1 && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(body[body.length - 1]) ? -1 : undefined)
  }
  if (kind === 'callout') {
    const rest = (body[0] ?? '').replace(/^\s{0,3}>\s?\[![A-Za-z]+\]\s*/, '')
    body = rest ? [`> ${rest}`, ...body.slice(1)] : body.slice(1)
  }
  const out = body.map(l => {
    let t = l
    if (kind === 'heading') t = t.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '')
    if (kind === 'quote' || kind === 'callout') t = t.replace(/^\s{0,3}>\s?/, '')
    if (LIST_KINDS.has(kind)) t = t.replace(LIST, '')
    return t
  })
  while (out.length && !out[0].trim()) out.shift()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

/** Kinds a block can be turned into (and what to call the operation's targets). */
export const TURN_INTO = ['paragraph', 'h1', 'h2', 'h3', 'bullet', 'ordered', 'task', 'quote', 'callout', 'code']

/** Markdown lines of `plain` content as `target`. */
export function asKind(plain, target, { variant = 'note', lang = '' } = {}) {
  const lines = plain.length ? plain : ['']
  switch (target) {
    case 'h1': case 'h2': case 'h3': case 'h4':
      return [`${'#'.repeat(Number(target[1]))} ${lines.map(l => l.trim()).join(' ').trim()}`]
    case 'bullet': return lines.map(l => `- ${l.trim()}`)
    case 'ordered': return lines.map((l, i) => `${i + 1}. ${l.trim()}`)
    case 'task': return lines.map(l => `- [ ] ${l.trim()}`)
    case 'quote': return lines.map(l => (l.trim() ? `> ${l}` : '>'))
    case 'callout': return [`> [!${variant.toUpperCase()}]`, ...lines.map(l => (l.trim() ? `> ${l}` : '>'))]
    case 'code': return ['```' + lang, ...lines, '```']
    default: return lines
  }
}

/** Turn a block into another kind. Tables, rules, embeds, html and frontmatter are left as they are. */
export function turnInto(input, index, target, options = {}) {
  const doc = docOf(input)
  const b = doc.blocks[index]
  if (!b || ['table', 'rule', 'html', 'frontmatter'].includes(b.kind)) return result(doc, doc.lines, b ? b.start : null)
  const plain = plainLines(doc.lines.slice(b.start, b.end), b.kind)
  const next = withEol(doc, asKind(plain, target, options))
  return result(doc, [...doc.lines.slice(0, b.start), ...next, ...doc.lines.slice(b.end)], b.start)
}

/** Tick or untick the to-do on line `line` of a task block (0-based within the block). */
export function toggleTask(input, index, line = 0) {
  const doc = docOf(input)
  const b = doc.blocks[index]
  const at = b ? b.start + line : -1
  if (!b || at >= b.end) return result(doc, doc.lines, null)
  const lines = [...doc.lines]
  lines[at] = lines[at].replace(/^(\s{0,3}[-*+]\s+\[)([ xX])(\])/, (_, a, c, z) => `${a}${c === ' ' ? 'x' : ' '}${z}`)
  return result(doc, lines, b.start)
}

// --- Containers (0.3): ops rebuild only the region they touch, blocks keep their bytes, pieces joined by a blank line

const MAX_DEPTH = 8

// [first, last] grown to whole containers under one parent.
function balance(doc, first, last) {
  const B = doc.blocks
  first = Math.max(0, Math.min(first, last))
  last = Math.min(B.length - 1, Math.max(first, last))
  for (let moved = true; moved;) {
    moved = false
    for (let k = first; k <= last; k++) {
      const b = B[k]
      if (b.fence === 'open' && b.close > last) { last = b.close; moved = true }
      if (b.fence === 'close' && b.open < first) { first = b.open; moved = true }
    }
    while (B[first].parent !== B[last].parent) {
      if (B[first].depth >= B[last].depth) first = B[first].parent
      else last = B[B[last].parent].close
      moved = true
    }
  }
  return [first, last]
}

const linesOf = (doc, first, last) => doc.lines.slice(doc.blocks[first].start, doc.blocks[last].end)
function joined(doc, pieces) {
  const out = []
  for (const p of pieces.filter(x => x.length)) { if (out.length) out.push(blankLine(doc)); out.push(...p) }
  return out
}
const splice = (doc, start, end, lines, focusLine) => result(doc, [...doc.lines.slice(0, start), ...lines, ...doc.lines.slice(end)], focusLine)

/** Tab: indent first..last, joining an adjacent container (after a toggle: into it). */
export function indentBlocks(input, first, last = first) {
  const doc = docOf(input)
  const B = doc.blocks
  if (!B.length) return result(doc, doc.lines, null)
  ;[first, last] = balance(doc, first, last)
  if (B[first].depth >= MAX_DEPTH) return result(doc, doc.lines, B[first].start)
  const body = linesOf(doc, first, last)
  const prev = B[first - 1]
  const next = B[last + 1]
  if (prev?.fence === 'close' && prev.depth === B[first].depth) {
    const lines = [...body, blankLine(doc), doc.lines[prev.start]]
    return splice(doc, prev.start, B[last].end, lines, prev.start)
  }
  if (next?.kind === 'container' && next.fence === 'open' && next.depth === B[last].depth) {
    return splice(doc, B[first].start, next.end, [doc.lines[next.start], blankLine(doc), ...body], B[first].start + 2)
  }
  const fence = withEol(doc, ['::: indent', ':::'])
  return splice(doc, B[first].start, B[last].end, [fence[0], blankLine(doc), ...body, blankLine(doc), fence[1]], B[first].start + 2)
}

/** Shift+Tab: out of the container (an indent splits; a toggle keeps the rest). */
export function outdentBlocks(input, first, last = first) {
  const doc = docOf(input)
  const B = doc.blocks
  if (!B.length) return result(doc, doc.lines, null)
  ;[first, last] = balance(doc, first, last)
  const p = B[first].parent
  if (p === null || p === undefined) return result(doc, doc.lines, B[first].start)
  const o = B[p]
  const c = B[o.close]
  const open = [doc.lines[o.start]]
  const close = [doc.lines[c.start]]
  const head = first > p + 1 ? linesOf(doc, p + 1, first - 1) : []
  const tail = last < o.close - 1 ? linesOf(doc, last + 1, o.close - 1) : []
  const mid = linesOf(doc, first, last)
  const wrap = (inner) => [...open, blankLine(doc), ...inner, ...(inner.length ? [blankLine(doc)] : []), ...close]
  const pieces = o.kind === 'toggle'
    ? [wrap(joined(doc, [head, tail])), mid]
    : [head.length ? wrap(head) : [], mid, tail.length ? wrap(tail) : []]
  const lines = joined(doc, pieces)
  const at = o.kind === 'toggle' ? lines.length - mid.length : head.length ? head.length + 4 : 0
  return splice(doc, o.start, c.end, lines, o.start + at)
}

const TITLE_MAX = 200
const TITLE_KINDS = new Set(['paragraph', 'heading', 'quote'])
const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** The block as a toggle title when nothing is lost (one line of a paragraph, heading or quote, within the limit); else null. */
function titleOf(doc, b) {
  if (b.end - b.start !== 1 || !TITLE_KINDS.has(b.kind)) return null
  const t = oneLine(plainLines(doc.lines.slice(b.start, b.end), b.kind).join(' '))
  return t.length <= TITLE_MAX ? t : null
}

/** A title taken from the block's first line of content, for a block that stays whole under it. */
function firstLineTitle(doc, b) {
  const first = plainLines(doc.lines.slice(b.start, b.end), b.kind === 'callout' ? 'paragraph' : b.kind)[0] ?? ''
  const t = oneLine(b.kind === 'table' ? first.replace(/\|/g, ' ') : first)
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`
}

/**
 * A block first in, or right before, an indent becomes its toggle title; else an empty toggle. Never lossy: a block that
 * cannot be a title (several lines, code, a table, a list, over the limit) is kept whole as the toggle's first child,
 * under a title from its first line. `quote` (the person typed "> " at the start of a block): only a one-line quote
 * turns, and not when `previous` (the block's markdown before the edit) was a quote already: editing a real blockquote
 * never converts it.
 */
export function toggleFrom(input, index, { quote = false, previous = null } = {}) {
  const doc = docOf(input)
  const B = doc.blocks
  const b = B[index]
  const same = () => result(doc, doc.lines, b ? b.start : null)
  if (!b || b.fence || b.kind === 'frontmatter') return same()
  if (quote && (b.kind !== 'quote' || b.end - b.start !== 1 || (previous !== null && /^\s{0,3}>/.test(String(previous))))) return same()
  const title = titleOf(doc, b)
  const body = title === null ? doc.lines.slice(b.start, b.end) : []
  const line = withEol(doc, [`::: toggle ${title ?? firstLineTitle(doc, b)}`.trim()])[0]
  const p = b.parent !== null ? B[b.parent] : null
  if (p && p.kind === 'container' && b.parent === index - 1) {
    if (body.length) return splice(doc, p.start, p.end, [line], p.start)
    const after = B[index + 1] ? B[index + 1].start : b.end
    return splice(doc, p.start, after, [line, blankLine(doc)], p.start)
  }
  const n = B[index + 1]
  if (n?.kind === 'container' && n.fence === 'open' && n.depth === b.depth) {
    return splice(doc, b.start, n.end, body.length ? [line, blankLine(doc), ...body] : [line], b.start)
  }
  if (quote) return same()
  const close = withEol(doc, [':::'])[0]
  return splice(doc, b.start, b.end, body.length ? [line, blankLine(doc), ...body, blankLine(doc), close] : [line, blankLine(doc), close], b.start)
}

/** The text inside one toggle, in its own line ending. */
export function wrapToggle(text = '', title = '') {
  const src = String(text)
  const eol = /\r\n/.test(src) ? '\r\n' : '\n'
  const body = src.replace(/^(\r?\n)+/, '').trimEnd()
  const t = String(title).replace(/\s+/g, ' ').trim().slice(0, 200)
  return [`::: toggle ${t}`.trim(), '', ...(body ? [body, ''] : []), ':::', ''].join(eol)
}
