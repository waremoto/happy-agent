// Hoja rich blocks (phase 4): one block at a time is edited as rich text, and only that block's lines are written back.
//
// The rule (design § 2): a rich edit replaces the edited block's line range and nothing else. Inside the block, a line
// the person did not change keeps its bytes, even where the serializer would spell it differently (`*` bullets,
// `__strong__`, `~~~` fences, a table without padding): the block's own markdown is serialized twice, once as it was
// loaded (the round trip) and once as edited, and every line the two serializations share is written with the
// original's bytes. So `git diff` shows the lines the person changed and blame survives everywhere else.
//
// Zero dependencies, like the core: the serializer reads ProseMirror JSON (`editor.getJSON()`, TipTap's node names),
// and the host parses markdown with its own renderer. The TipTap adapter is in `tiptap.mjs`.
import { parseDoc } from './blocks.mjs'
import { diffEdit, insertBlock, removeBlock } from './ops.mjs'

/** Kinds a rich editor shows faithfully; the rest (callouts, HTML, frontmatter, diagrams, embeds, containers) are
 *  edited as their markdown source, still one block at a time. */
const RICH = new Set(['heading', 'paragraph', 'bullet', 'ordered', 'task', 'quote', 'code', 'table', 'rule'])
const DIAGRAM = /^(mermaid|roadmap|yaml-tree)$/i

/** 'rich' when the block's kind round-trips through rich text, else 'source'. */
export function richKind(block) {
  if (!block || !RICH.has(block.kind)) return 'source'
  if (block.kind === 'code' && DIAGRAM.test(block.lang ?? '')) return 'source'
  return 'rich'
}

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)

/** How the block's markdown is spelled, so new lines match the lines around them. */
export function blockStyle(markdown = '') {
  const text = String(markdown)
  const bullet = /^\s*([-*+])\s/m.exec(text)?.[1] ?? '-'
  const delim = /^\s*\d{1,9}([.)])\s/m.exec(text)?.[1] ?? '.'
  const strong = /__[^_\s][^_]*__/.test(text) && !/\*\*[^*\s]/.test(text) ? '__' : '**'
  const em = /(^|[^\w_])_[^_\s][^_]*_(?![\w_])/.test(text.replace(/__/g, '')) && !/(^|[^*])\*[^*\s][^*]*\*(?!\*)/.test(text) ? '_' : '*'
  const fence = /^\s*(~{3,})/m.test(text) ? '~' : '`'
  const indent = /^( +)[-*+]\s/m.exec(text.split('\n').slice(1).join('\n'))?.[1].length ?? 0
  const blank = text.split('\n').some(l => !l.trim())
  return { bullet, delim, strong, em, fence, indent, tight: !blank }
}

// ---------------------------------------------------------------------------------------------------------------------
// Soft line breaks. A paragraph wrapped over several source lines renders as one line of text, so an edit would re-flow
// it onto one line and rewrite all of them. The host's renderer turns each soft break into `<br data-hoja-soft>` and its
// editor keeps that flag on the hard-break node; the serializer writes a flagged break back as a plain newline.

/** markdown-it: render soft breaks as flagged `<br>` (for the block editor only, never for Read). */
export function markdownItSoftBreaks(md) {
  md.renderer.rules.softbreak = () => '<br data-hoja-soft="">'
  return md
}

/** TipTap `addGlobalAttributes()` for the flag: `Extension.create({ name: 'hojaSoftBreak', addGlobalAttributes: richGlobalAttributes })`. */
export function richGlobalAttributes() {
  return [{
    types: ['hardBreak'],
    attributes: {
      soft: {
        default: false,
        parseHTML: (el) => el.hasAttribute('data-hoja-soft'),
        renderHTML: (attrs) => (attrs.soft ? { 'data-hoja-soft': '' } : {})
      }
    }
  }]
}

// ---------------------------------------------------------------------------------------------------------------------
// Serializer: ProseMirror JSON (TipTap names) → markdown

const ORDER = ['link', 'bold', 'italic', 'strike', 'code']
const markKey = (m) => (m.type === 'link' ? `link:${m.attrs?.href ?? ''}:${m.attrs?.title ?? ''}` : m.type)
const known = (m) => ORDER.includes(m.type)

function escapeText(text, { cell = false } = {}) {
  let out = text
    .replace(/\\(?=[\\`*_{}[\]()#+\-.!|<>~])/g, '\\\\')
    .replace(/[`*]/g, '\\$&')
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'))
    .replace(/~~/g, '\\~\\~')
    .replace(/\[(?=[^\]]*\]\()/g, '\\[')
  if (cell) out = out.replace(/\|/g, '\\|')
  return out
}

/** A line that would start a block when it should be text (a paragraph beginning with "# " or "1. "). */
function escapeLineStart(line) {
  return line
    .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s{0,3})>/, '$1\\>')
    .replace(/^(\s{0,3})([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s{0,3})(\d{1,9})([.)])(?=\s)/, '$1$2\\$3')
    .replace(/^(\s{0,3})(={3,}|-{3,})\s*$/, '$1\\$2')
}

function codeSpan(text) {
  const runs = text.match(/`+/g) ?? []
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0) + 1
  const tick = '`'.repeat(n)
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? ' ' : ''
  return `${tick}${pad}${text}${pad}${tick}`
}

function open(m, style) {
  if (m.type === 'bold') return style.strong
  if (m.type === 'italic') return style.em
  if (m.type === 'strike') return '~~'
  if (m.type === 'link') return '['
  return ''
}
function close(m, style) {
  if (m.type === 'link') {
    const href = String(m.attrs?.href ?? '').replace(/[()\s]/g, c => encodeURI(c).replace('(', '%28').replace(')', '%29'))
    const title = m.attrs?.title ? ` "${String(m.attrs.title).replace(/"/g, '\\"')}"` : ''
    return `](${href}${title})`
  }
  return open(m, style)
}

/** Inline content → markdown text ("\n" only where a hard break was). */
function inline(nodes = [], style, opts = {}) {
  let out = ''
  let stack = []
  const shut = (to) => {
    while (stack.length > to) out += close(stack.pop(), style)
  }
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      shut(0)
      out += opts.cell || opts.heading ? ' ' : n.attrs?.soft ? '\n' : '\\\n'
      continue
    }
    if (n.type === 'image') {
      shut(0)
      out += `![${escapeText(n.attrs?.alt ?? '')}](${n.attrs?.src ?? ''})`
      continue
    }
    if (n.type !== 'text') {
      out += inline(n.content, style, opts)
      continue
    }
    const marks = (n.marks ?? []).filter(known).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
    const keys = marks.map(markKey)
    let keep = 0
    while (keep < stack.length && keep < keys.length && markKey(stack[keep]) === keys[keep]) keep++
    shut(keep)
    const code = marks.some(m => m.type === 'code')
    for (const m of marks.slice(keep)) if (m.type !== 'code') { out += open(m, style); stack.push(m) }
    const text = n.text ?? ''
    out += code ? codeSpan(text) : escapeText(text, opts)
  }
  shut(0)
  return out
}

const prefixLines = (text, first, rest) => text.split('\n').map((l, i) => (i === 0 ? first : (l ? rest : rest.trimEnd())) + l).join('\n')

function listItems(node, style, ordered, task) {
  let n = ordered ? Number(node.attrs?.start ?? 1) : 0
  return (node.content ?? []).map((item) => {
    const marker = ordered ? `${n++}${style.delim} ` : `${style.bullet} `
    const check = task || item.type === 'taskItem' ? `[${item.attrs?.checked ? 'x' : ' '}] ` : ''
    const width = Math.max(marker.length, style.indent || 0)
    const body = blocks(item.content ?? [], style, true)
    return prefixLines(check + body, marker, ' '.repeat(width))
  }).join(style.looseItems ? '\n\n' : '\n')
}

function table(node, style) {
  const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell =>
    (cell.content ?? []).map(p => inline(p.content, style, { cell: true })).join(' ').trim()))
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(r => r.length))
  const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`
  return [line(rows[0]), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

function block(node, style) {
  switch (node.type) {
    case 'paragraph': return inline(node.content, style).split('\n').map(escapeLineStart).join('\n')
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))))} ${inline(node.content, style, { heading: true })}`.trimEnd()
    case 'bulletList': return listItems(node, style, false, false)
    case 'orderedList': return listItems(node, style, true, false)
    case 'taskList': return listItems(node, style, false, true)
    case 'blockquote': return prefixLines(blocks(node.content ?? [], style, false).replace(/\n/g, '\n'), '> ', '> ').split('\n').map(l => (l === '> ' ? '>' : l)).join('\n')
    case 'codeBlock': {
      const text = (node.content ?? []).map(t => t.text ?? '').join('')
      const ch = style.fence === '~' ? '~' : '`'
      const longest = (text.match(new RegExp(`^\\s*${ch === '`' ? '`' : '~'}{3,}`, 'gm')) ?? []).reduce((m, r) => Math.max(m, r.trim().length), 0)
      const fence = ch.repeat(Math.max(3, longest + 1))
      return `${fence}${node.attrs?.language ?? ''}\n${text}${text && !text.endsWith('\n') ? '\n' : ''}${fence}`
    }
    case 'horizontalRule': return '---'
    case 'table': return table(node, style)
    case 'image': return inline([node], style)
    default: return node.content ? blocks(node.content, style, false) : ''
  }
}

const TIGHT_OK = new Set(['bulletList', 'orderedList', 'taskList', 'codeBlock', 'blockquote'])

/** Block children → markdown. In a tight source block (no blank line) a list or fence follows its paragraph directly. */
function blocks(nodes, style, inItem) {
  let out = ''
  nodes.forEach((n, i) => {
    const text = block(n, style)
    if (i > 0) {
      const prev = nodes[i - 1].type
      const glued = inItem ? n.type !== 'paragraph' || prev !== 'paragraph' : style.tight && (TIGHT_OK.has(n.type) || TIGHT_OK.has(prev)) && n.type !== 'table'
      out += glued ? '\n' : '\n\n'
    }
    out += text
  })
  return out
}

/** ProseMirror JSON (a doc or a node list) → markdown, spelled per `style` (see `blockStyle`). */
export function richMarkdown(json, style = blockStyle('')) {
  const nodes = Array.isArray(json) ? json : json?.type === 'doc' ? json.content ?? [] : json ? [json] : []
  return blocks(nodes, { ...blockStyle(''), ...style }, false)
}

// ---------------------------------------------------------------------------------------------------------------------
// Faithful write-back

/** Longest common subsequence pairs [i, j] of two short line lists (null when too large to align). */
function lcsPairs(a, b) {
  if (a.length * b.length > 250_000) return null
  const w = b.length + 1
  const t = new Uint16Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++ } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * The lines to write for an edited block: `edited` (the edited serialization), except that every line it shares with
 * `roundTrip` (the serialization of the block as loaded) is written as the matching `original` line, byte for byte.
 * When the round trip does not keep the original's line count (a soft-wrapped paragraph, a setext heading), lines are
 * matched against the original directly.
 */
export function faithfulLines(original, roundTrip, edited) {
  const same = roundTrip.length === original.length
  const pairs = lcsPairs(same ? roundTrip : original.map(bare), edited)
  if (!pairs) return edited.slice()
  const out = edited.slice()
  for (const [i, j] of pairs) out[j] = original[i]
  return out
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Where a block opened for editing is now: its own index when the checksum still matches, else the one block with its
 * checksum, else -1 (someone changed or removed it: never guess).
 */
export function relocateBlock(input, block) {
  const doc = typeof input === 'string' ? parseDoc(input) : input
  if (doc.blocks[block.index]?.checksum === block.checksum) return block.index
  const hits = doc.blocks.filter(b => b.checksum === block.checksum)
  return hits.length === 1 ? hits[0].index : -1
}

/**
 * The write-back of one rich edit: `{ text, edit, focus }` replacing only the block's changed lines, or null when the
 * edit changed nothing. `before` is the editor's JSON as loaded, `after` as edited; `markdown` is the edited block's
 * source as loaded (`block.start..end` of `input` unless it moved since: pass the block it was opened as).
 * `{ conflict: true, lines }` when the block was changed by someone else meanwhile (the host decides; never overwrite).
 */
export function richEdit(input, opened, { before, after, lines: plain }) {
  const doc = typeof input === 'string' ? parseDoc(input) : input
  const index = relocateBlock(doc, opened)
  const b = doc.blocks[index]
  if (plain === undefined && sameJson(before, after)) return null
  const original = b ? doc.lines.slice(b.start, b.end) : opened.lines ?? []
  const style = blockStyle(original.map(bare).join('\n'))
  const crlf = doc.eol === '\r\n'
  const roundTrip = plain === undefined ? toEditLines(richMarkdown(before, style)) : original.map(bare)
  const edited = plain === undefined ? toEditLines(richMarkdown(after, style)) : plain.map(bare)
  let next = faithfulLines(original, roundTrip, edited)
  next = next.map((l, j) => (crlf && !l.endsWith('\r') && edited[j] === l ? `${l}\r` : l))
  if (index < 0 || !b) return { conflict: true, lines: next }
  if (next.length === original.length && next.every((l, i) => l === original[i])) return null
  if (!next.some(l => l.trim())) return removeBlock(doc, index)
  const inner = diffEdit(original, next)
  const edit = { from: b.start + inner.from, to: b.start + inner.to, lines: inner.lines }
  const all = [...doc.lines.slice(0, edit.from), ...edit.lines, ...doc.lines.slice(edit.to)]
  return { text: all.join('\n'), edit, focus: index }
}

/** Serialized markdown → lines, without the trailing blank lines a block cannot hold. */
function toEditLines(markdown) {
  const lines = markdown.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

/**
 * A new block typed in a rich editor opened below block `after` (`{ index, checksum }`, or null for the top): the
 * markdown inserted after that block where it is now, or null when nothing was typed. `{ conflict, lines }` when the
 * block it was opened under is gone.
 */
export function richInsert(input, after, { after: json, lines: plain }) {
  const doc = typeof input === 'string' ? parseDoc(input) : input
  const lines = plain === undefined ? toEditLines(richMarkdown(json, blockStyle(''))) : plain.map(bare)
  if (!lines.some(l => l.trim())) return null
  const index = after ? relocateBlock(doc, after) : -1
  if (after && index < 0) return { conflict: true, lines }
  return insertBlock(doc, index, lines.join('\n'))
}
