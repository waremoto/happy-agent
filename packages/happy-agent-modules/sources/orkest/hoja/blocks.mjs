// Hoja blocks: a markdown source read as blocks, each an exact line range of the source.
//
// Boundaries are Orkest's (`layers/orkest/collab/orkestBlocks.mjs`, ORK-000030.2.1): a heading line is its own block, a
// fenced block runs fence to fence (blank lines inside it included), anything else is a run of non-blank lines. Blank
// lines belong to no block. A leading `---` frontmatter is one block too. Lines are split on "\n" only, so a CRLF
// document keeps its "\r" inside each line and every untouched byte survives an operation.

/** FNV-1a 32-bit over the UTF-16 code units, twice (two seeds), plus the line count. Same digest as Orkest's. */
export function blockChecksum(lines) {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  const text = lines.join('\n')
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x01000193) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}.${lines.length}`
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^\s{0,3}(#{1,6})(?:\s|$)/
const TASK = /^\s{0,3}[-*+]\s+\[[ xX]\](?:\s|$)/
const BULLET = /^\s{0,3}[-*+]\s+/
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+/
const CALLOUT = /^\s{0,3}>\s?\[!([A-Za-z]+)\]/
const QUOTE = /^\s{0,3}>/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const URL_LINE = /^\s*(?:<)?https?:\/\/\S+?(?:>)?\s*$/
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/
const HTML = /^\s{0,3}<(?:[A-Za-z][\w-]*|!--)/
// Containers: `::: indent` / `::: toggle <title>` … `:::` (pandoc fenced divs).
const OPEN = /^\s{0,3}:{3,}\s*(indent|toggle)\b\s*(.*)$/
const CLOSE = /^\s{0,3}:{3,}\s*$/
const isFence = (line) => OPEN.test(line) || CLOSE.test(line)
// Another tool's fenced div (`:::note`, `::: warning`, `:::{.class}`): one opaque block up to its own close, so its
// `:::` never closes one of ours.
const FOREIGN = /^\s{0,3}:{3,}\s*[^\s:]/
const DIV_OPEN = /^\s{0,3}:{3,}\s*\S/

/** The end (exclusive) of a foreign div opened at line `i`, or -1 when it never closes. */
function foreignEnd(lines, i) {
  let depth = 1
  for (let j = i + 1; j < lines.length; j++) {
    const l = bare(lines[j])
    if (CLOSE.test(l)) { if (--depth === 0) return j + 1 }
    else if (DIV_OPEN.test(l)) depth++
  }
  return -1
}

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)
const blank = (line) => !line.trim()

/** The source's lines ("\n" split; a trailing "\r" stays part of its line). */
export function toLines(text = '') {
  return String(text ?? '').split('\n')
}

/** "\r\n" when most non-empty lines end in "\r", else "\n": the line ending new lines are written with. */
export function eolOf(lines) {
  let cr = 0
  let n = 0
  for (const l of lines) {
    if (!l) continue
    n++
    if (l.endsWith('\r')) cr++
  }
  return n && cr * 2 > n ? '\r\n' : '\n'
}

function fenceEnd(lines, i, mark, len) {
  const close = new RegExp(`^\\s{0,3}${mark === '`' ? '`' : '~'}{${len},}\\s*$`)
  let j = i + 1
  while (j < lines.length && !close.test(bare(lines[j]))) j++
  return Math.min(j + 1, lines.length)
}

/** The kind of a non-fence, non-heading run of lines. */
function textKind(first, second) {
  if (TASK.test(first)) return { kind: 'task' }
  if (RULE.test(first) && second === undefined) return { kind: 'rule' }
  if (BULLET.test(first)) return { kind: 'bullet' }
  if (ORDERED.test(first)) return { kind: 'ordered' }
  const callout = CALLOUT.exec(first)
  if (callout) return { kind: 'callout', variant: callout[1].toLowerCase() }
  if (QUOTE.test(first)) return { kind: 'quote' }
  if (first.includes('|') && second !== undefined && TABLE_SEP.test(second)) return { kind: 'table' }
  if (second === undefined && (URL_LINE.test(first) || IMAGE_LINE.test(first))) return { kind: 'embed' }
  if (HTML.test(first)) return { kind: 'html' }
  return { kind: 'paragraph' }
}

/**
 * Every block of the source: { index, start, end (exclusive), kind, level?, variant?, lang?, checksum, depth, parent }.
 * Kinds: heading, paragraph, bullet, ordered, task, quote, callout, code, mermaid, table, rule, embed, html,
 * frontmatter, toggle (`title`), container (`::: indent` or `:::`). Fences carry `fence` open|close and `close`/`open`.
 */
export function parseBlocks(text = '') {
  const lines = Array.isArray(text) ? text : toLines(text)
  const out = []
  let i = 0
  const push = (start, end, info) => out.push({ index: out.length, start, end, ...info, checksum: blockChecksum(lines.slice(start, end)) })
  // A leading BOM is part of the first line's bytes but not of its kind.
  const lineAt = (k) => (k === 0 ? bare(lines[0]).replace(/^\uFEFF/, '') : bare(lines[k]))
  if (lines.length > 1 && lineAt(0) === '---') {
    let j = 1
    while (j < lines.length && bare(lines[j]) !== '---' && bare(lines[j]) !== '...') j++
    if (j < lines.length) {
      push(0, j + 1, { kind: 'frontmatter' })
      i = j + 1
    }
  }
  while (i < lines.length) {
    const line = lineAt(i)
    if (blank(line)) { i++; continue }
    const fence = FENCE.exec(line)
    if (fence) {
      const end = fenceEnd(lines, i, fence[1][0], fence[1].length)
      const lang = fence[2].trim().split(/\s+/)[0]?.toLowerCase() || ''
      push(i, end, { kind: lang === 'mermaid' ? 'mermaid' : 'code', lang })
      i = end
      continue
    }
    if (FOREIGN.test(line) && !OPEN.test(line)) {
      const end = foreignEnd(lines, i)
      if (end > 0) {
        push(i, end, { kind: 'admonition', variant: line.replace(/^\s*:+\s*/, '').split(/[\s{]/)[0].toLowerCase() || 'div' })
        i = end
        continue
      }
    }
    if (isFence(line)) {
      const m = OPEN.exec(line)
      push(i, i + 1, m ? (m[1] === 'toggle' ? { kind: 'toggle', fence: 'open', title: m[2].trim() } : { kind: 'container', fence: 'open' }) : { kind: 'container', fence: 'close' })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      push(i, i + 1, { kind: 'heading', level: heading[1].length })
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && !blank(bare(lines[j])) && !HEADING.test(bare(lines[j])) && !FENCE.test(bare(lines[j])) && !isFence(bare(lines[j]))) j++
    push(i, j, textKind(line, j > i + 1 ? bare(lines[i + 1]) : undefined))
    i = j
  }
  return nest(out, lines)
}

// Pair fences by a stack, set depth and parent; an unpaired fence is text.
function nest(out, lines) {
  const stack = []
  const paired = new Set()
  for (const b of out) {
    if (b.fence === 'open') stack.push(b)
    else if (b.fence === 'close' && stack.length) { const o = stack.pop(); o.close = b.index; b.open = o.index; paired.add(o).add(b) }
  }
  const open = []
  for (const b of out) {
    if (b.fence && !paired.has(b)) { delete b.fence; delete b.title; Object.assign(b, textKind(bare(lines[b.start]))) }
    if (b.fence === 'close') open.pop()
    b.depth = open.length
    b.parent = open.length ? open[open.length - 1].index : null
    if (b.fence === 'open') open.push(b)
  }
  return out
}

/** A parsed document: its lines, blocks and line ending. Operations take and return one. */
export function parseDoc(text = '') {
  const lines = toLines(text)
  return { lines, blocks: parseBlocks(lines), eol: eolOf(lines) }
}

/** The block's source lines (without "\r"). */
export function blockLines(doc, index) {
  const b = doc.blocks[index]
  return b ? doc.lines.slice(b.start, b.end).map(bare) : []
}

/** The block's markdown ("\n" joined, without "\r"). */
export function blockText(doc, index) {
  return blockLines(doc, index).join('\n')
}

/** The block containing line `at`, or the next one below a blank line; null past the end. Same rule as Orkest's. */
export function blockAtLine(doc, at) {
  return doc.blocks.find(b => at >= b.start && at < b.end) ?? doc.blocks.find(b => b.start > at) ?? null
}

/** The heading's plain text (markers and trailing #s removed). */
export function headingText(line) {
  return bare(line).replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim()
}

/** GitHub-style anchor slug, so a copied link also works on GitHub and in Orkest's renderer. */
export function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[`*_~[\]()<>]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

/**
 * The section a heading block opens: the heading plus every block until the next heading of the same or a higher
 * level. For a non-heading block, just the block. { first, last (block indices, inclusive), start, end (lines) }.
 */
export function sectionOf(doc, index) {
  const b = doc.blocks[index]
  if (!b) return null
  if (b.kind === 'toggle' && b.close != null) return { first: index, last: b.close, start: b.start, end: doc.blocks[b.close].end }
  if (b.kind !== 'heading') return { first: index, last: index, start: b.start, end: b.end }
  let last = index
  for (let k = index + 1; k < doc.blocks.length; k++) {
    const n = doc.blocks[k]
    if ((n.depth ?? 0) < (b.depth ?? 0) || (n.kind === 'heading' && n.level <= b.level && n.depth === b.depth)) break
    last = k
    if (n.fence === 'open' && n.close != null) k = last = n.close
  }
  return { first: index, last, start: b.start, end: doc.blocks[last].end }
}

/** Headings with their unique anchors (GitHub numbering for repeats): [{ index, level, text, slug }]. */
export function outline(doc) {
  const seen = new Map()
  return doc.blocks.filter(b => b.kind === 'heading').map(b => {
    const text = headingText(doc.lines[b.start])
    const base = slugify(text) || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { index: b.index, level: b.level, text, slug: n ? `${base}-${n}` : base }
  })
}

/** The anchor that addresses a block in a link: its heading's slug, else `block-<index>`. */
export function blockAnchor(doc, index) {
  const h = outline(doc).find(o => o.index === index)
  return h ? h.slug : `block-${index}`
}

/** The block a hash names (`block-<n>` or a heading slug), or -1. */
export function blockTarget(doc, hash = '') {
  const h = String(hash).replace(/^#/, '')
  const n = /^block-(\d+)$/.exec(h)
  if (n) return Number(n[1]) < doc.blocks.length ? Number(n[1]) : -1
  return outline(doc).find(o => o.slug === h)?.index ?? -1
}

/** Whether a block address ({ index, checksum }) still names the same lines. */
export function blockState(doc, address) {
  const b = address && doc.blocks[address.index]
  if (!b) return 'orphaned'
  return b.checksum === address.checksum ? 'fresh' : 'stale'
}
