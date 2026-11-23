// Hoja proposals: a whole proposed document compared with the current one, as hunks a person accepts or undoes.
//
// The proposer (a model) rewrites the full document; it never addresses lines. proposalHunks aligns the two block lists
// (an LCS over each block's text), so every unchanged block stays an anchor and each run of changed blocks becomes one
// hunk, split at headings when both sides keep the same section shape. applyHunks then writes chosen hunks into the
// CURRENT body, each found again by its checksums, never by line numbers: a hunk whose blocks moved or were edited since
// fails alone (`stale`) and the others still apply. Lines outside a hunk keep their bytes (the Hoja rule).
import { blockChecksum, blockLines, blockText, headingText, parseDoc, slugify } from './blocks.mjs'
import { plainLines } from './ops.mjs'

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)
const isBlank = (line) => !bare(line).trim()
/**
 * The text two blocks are compared by. A leading BOM and trailing spaces at a line's end do not count, except where they
 * mean something: inside a code fence, and two or more spaces before a line break (a Markdown hard break).
 */
function keyOf(text, kind = 'paragraph') {
  const lines = String(text).replace(/^\uFEFF/, '').split('\n')
  if (kind === 'code' || kind === 'mermaid') return lines.join('\n')
  return lines.map((l, k) => l.replace(/[ \t]+$/, m => (k < lines.length - 1 && m.length >= 2 ? '  ' : ''))).join('\n')
}
const withEol = (eol, lines) => (eol === '\r\n' ? lines.map(l => `${bare(l)}\r`) : lines.map(bare))
/** A block's line-ending-free checksum: what hunks are located by, so a mixed or changed line ending never matters. */
const sumOf = (doc, i) => blockChecksum(blockLines(doc, i))
const sumText = (text) => blockChecksum(String(text).split('\n'))
// Context tokens: the top and the end of the document, and "any block" (hunks stored before 0.3.1 carry no context).
const TOP = '^'
const END = '$'
const ANY = '*'

/** Longest common subsequence of two key lists: the matched index pairs, in order. Bounded (see `align`). */
function lcsPairs(a, b) {
  const out = []
  align(a, b, 0, a.length, 0, b.length, out)
  return out
}

/** Cells of one LCS table (4 bytes each): 16 MB. A larger gap is cut at blocks unique on both sides, else left whole. */
const CELLS = 4_000_000

function align(a, b, a0, a1, b0, b1, out) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push([a0++, b0++])
  const tail = []
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) tail.push([--a1, --b1])
  const n = a1 - a0
  const m = b1 - b0
  if (n && m) {
    if (n * m <= CELLS) table(a, b, a0, b0, n, m, out)
    else {
      // Patience step: blocks that occur once on each side, in increasing order on both, are safe anchors; the gaps
      // between them are aligned again. No anchor: the whole gap stays one changed run (a coarse but correct hunk).
      const anchors = uniqueAnchors(a, b, a0, a1, b0, b1)
      let i = a0
      let j = b0
      for (const [x, y] of anchors) {
        align(a, b, i, x, j, y, out)
        out.push([x, y])
        i = x + 1
        j = y + 1
      }
      if (anchors.length) align(a, b, i, a1, j, b1, out)
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k])
}

function table(a, b, a0, b0, n, m, out) {
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) { out.push([a0 + i, b0 + j]); i++; j++ }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
    else j++
  }
}

/** Keys unique in a[a0,a1) and in b[b0,b1), paired, reduced to the longest run increasing on both sides. */
function uniqueAnchors(a, b, a0, a1, b0, b1) {
  const count = (list, s, e) => {
    const m = new Map()
    for (let k = s; k < e; k++) { const c = m.get(list[k]); m.set(list[k], c ? { n: c.n + 1, at: k } : { n: 1, at: k }) }
    return m
  }
  const ca = count(a, a0, a1)
  const cb = count(b, b0, b1)
  const pairs = []
  for (let i = a0; i < a1; i++) {
    const x = ca.get(a[i])
    const y = cb.get(a[i])
    if (x.n === 1 && y?.n === 1) pairs.push([i, y.at])
  }
  // longest increasing subsequence on the b side (patience sorting with back links)
  const tops = []
  const prev = new Array(pairs.length)
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0
    let hi = tops.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tops[mid]][1] < pairs[k][1]) lo = mid + 1; else hi = mid }
    prev[k] = lo ? tops[lo - 1] : -1
    tops[lo] = k
  }
  const out = []
  for (let k = tops.length ? tops[tops.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k])
  return out.reverse()
}

const WORD_CELLS = 2_500_000

/**
 * Word-level diff of two plain texts: [{ t: 'eq' | 'add' | 'del', w }] over whitespace-separated words, in reading order
 * (deleted words before the added ones that replace them). Very long texts fall back to delete-all/add-all in the middle.
 */
export function wordDiff(a = '', b = '') {
  const x = String(a).match(/\S+/g) ?? []
  const y = String(b).match(/\S+/g) ?? []
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const out = x.slice(0, p).map(w => ({ t: 'eq', w }))
  const xs = x.slice(p, x.length - s)
  const ys = y.slice(p, y.length - s)
  if (xs.length * ys.length > WORD_CELLS) {
    out.push(...xs.map(w => ({ t: 'del', w })), ...ys.map(w => ({ t: 'add', w })))
  } else {
    const pairs = lcsPairs(xs, ys)
    let i = 0
    let j = 0
    for (const [pi, pj] of [...pairs, [xs.length, ys.length]]) {
      while (i < pi) out.push({ t: 'del', w: xs[i++] })
      while (j < pj) out.push({ t: 'add', w: ys[j++] })
      if (pi < xs.length) out.push({ t: 'eq', w: xs[pi] })
      i = pi + 1
      j = pj + 1
    }
  }
  out.push(...x.slice(x.length - s).map(w => ({ t: 'eq', w })))
  return out
}

/** A block's readable text, markers and inline syntax removed (what a renderer shows), for word marks and counts. */
export function plainText(markdown = '', kind = 'paragraph') {
  const lines = plainLines(String(markdown).split('\n'), kind)
  return lines.join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/\*\*|__|~~|`|\*/g, '')
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
}

const wordCount = (text) => (String(text).match(/\S+/g) ?? []).length

function blockInfo(doc, index) {
  const b = doc.blocks[index]
  return { index, checksum: b.checksum, kind: b.kind, ...(b.level ? { level: b.level } : {}), text: blockText(doc, index) }
}
const anchorOf = (doc, index) => (index >= 0 ? { index, checksum: doc.blocks[index].checksum } : { index: -1, checksum: '' })

/**
 * Split one changed run into per-section hunks. Each side is cut at its headings into groups (the blocks before the
 * first heading are a lead group); groups are paired by heading text (an LCS), so a section removed or added next to a
 * changed one is its own hunk. Unpaired groups between two pairs pair up in order when both sides have as many, else
 * they stay one hunk.
 */
function splitRun(aIdx, bIdx, a, b) {
  const groups = (doc, list) => {
    const out = []
    for (const i of list) {
      if (!out.length || doc.blocks[i].kind === 'heading') out.push([i])
      else out[out.length - 1].push(i)
    }
    return out
  }
  if (!aIdx.length || !bIdx.length) return [[aIdx, bIdx]]
  const ga = groups(a, aIdx)
  const gb = groups(b, bIdx)
  if (ga.length < 2 && gb.length < 2) return [[aIdx, bIdx]]
  const key = (doc, g) => (doc.blocks[g[0]].kind === 'heading' ? 'h:' + keyOf(headingText(doc.lines[doc.blocks[g[0]].start])).toLowerCase() : '')
  const out = []
  const flush = (xs, ys) => {
    if (!xs.length && !ys.length) return
    if (!xs.length || !ys.length) {
      for (const g of xs) out.push([g, []])
      for (const g of ys) out.push([[], g])
    } else if (xs.length === ys.length) xs.forEach((g, k) => out.push([g, ys[k]]))
    else out.push([xs.flat(), ys.flat()])
  }
  let i = 0
  let j = 0
  for (const [pi, pj] of [...lcsPairs(ga.map(g => key(a, g)), gb.map(g => key(b, g))), [ga.length, gb.length]]) {
    flush(ga.slice(i, pi), gb.slice(j, pj))
    if (pi < ga.length) out.push([ga[pi], gb[pj]])
    i = pi + 1
    j = pj + 1
  }
  return out
}

function sectionFor(hunk, a, b) {
  const first = hunk.afterBlocks[0] ?? hunk.beforeBlocks[0]
  if (first?.kind === 'heading') return { title: headingText(first.text), slug: slugify(headingText(first.text)) || 'section' }
  const search = (doc, from) => {
    for (let k = from; k >= 0; k--) {
      const blk = doc.blocks[k]
      if (blk?.kind === 'heading') { const title = headingText(doc.lines[blk.start]); return { title, slug: slugify(title) || 'section' } }
    }
    return null
  }
  const fromB = hunk.afterBlocks.length ? hunk.afterBlocks[0].index - 1 : hunk.afterAnchor.index
  return search(b, fromB) ?? search(a, hunk.beforeBlocks.length ? hunk.beforeBlocks[0].index - 1 : hunk.anchor.index) ?? { title: '', slug: '' }
}

function hunkId(h, seen) {
  const base = 'h' + blockChecksum([h.kind, h.anchor.checksum, ...h.beforeBlocks.map(x => x.checksum), '|', ...h.afterBlocks.map(x => x.checksum)]).slice(0, 12)
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n ? `${base}-${n}` : base
}

/**
 * The neighbour context of each group of one changed run: which block checksums may sit right before (`prev`) and right
 * after (`next`) it in a body the proposal is (partly) written into. A neighbour inside the run is a sibling group,
 * written or not, so both its before and its after block count; a sibling with an empty side lets the one beyond it
 * count too. At the run's ends: the unchanged neighbour's checksum on both sides (bytes may differ in trailing spaces or
 * line endings), or the top / end of the document.
 */
function contexts(groups, left, right) {
  return groups.map((_, t) => {
    const prev = []
    let open = true
    for (let s = t - 1; s >= 0 && open; s--) {
      const g = groups[s]
      if (g.before.length) prev.push(g.before[g.before.length - 1])
      if (g.after.length) prev.push(g.after[g.after.length - 1])
      open = !(g.before.length && g.after.length)
    }
    if (open) prev.push(...left)
    const next = []
    open = true
    for (let s = t + 1; s < groups.length && open; s++) {
      const g = groups[s]
      if (g.before.length) next.push(g.before[0])
      if (g.after.length) next.push(g.after[0])
      open = !(g.before.length && g.after.length)
    }
    if (open) next.push(...right)
    return { prev: [...new Set(prev)], next: [...new Set(next)] }
  })
}

/**
 * The hunks that turn `before` into `after` (both Markdown sources). Each hunk:
 *   { id, kind: 'add' | 'del' | 'change', section: { title, slug }, anchor, afterAnchor, context, eol,
 *     beforeBlocks: [{ index, checksum, kind, text }], afterBlocks: [...], words? }
 * `anchor` / `afterAnchor` are the block right before the hunk in each document ({ index: -1 } at the top). `context`
 * ({ prev, next }: line-ending-free checksums, '^' top, '$' end) is what the hunk is located by: a run of blocks is taken
 * only where it is the one match or the one match with this context, never the nearest. `eol` is `before`'s line ending,
 * used when the hunk is written into an empty body. `words` (change hunks) is wordDiff of the plain texts.
 */
export function proposalHunks(before = '', after = '') {
  const a = parseDoc(String(before ?? ''))
  const afterLines = withEol(a.eol, String(after ?? '').replace(/\r\n?/g, '\n').split('\n'))
  const b = parseDoc(afterLines.join('\n'))
  const ka = a.blocks.map((x, i) => keyOf(blockText(a, i), x.kind))
  const kb = b.blocks.map((x, i) => keyOf(blockText(b, i), x.kind))
  const sa = a.blocks.map((_, i) => sumOf(a, i))
  const sb = b.blocks.map((_, i) => sumOf(b, i))
  const pairs = lcsPairs(ka, kb)
  // The whole document's block list before and once every hunk is written (unchanged blocks keep before's bytes): a
  // body that is exactly one of them is located by the recorded indices, so repeated sections never make it ambiguous.
  const written = [...sb]
  for (const [x, y] of pairs) written[y] = sa[x]
  const base = [blockChecksum(sa), blockChecksum(written)]
  const hunks = []
  const seen = new Map()
  let i = 0
  let j = 0
  for (const [pi, pj] of [...pairs, [a.blocks.length, b.blocks.length]]) {
    if (i < pi || j < pj) {
      const aIdx = Array.from({ length: pi - i }, (_, k) => i + k)
      const bIdx = Array.from({ length: pj - j }, (_, k) => j + k)
      const groups = splitRun(aIdx, bIdx, a, b)
      const left = i > 0 ? [sa[i - 1], sb[j - 1]] : [TOP]
      const right = pi < a.blocks.length ? [sa[pi], sb[pj]] : [END]
      const ctx = contexts(groups.map(([ga, gb]) => ({ before: ga.map(x => sa[x]), after: gb.map(x => sb[x]) })), left, right)
      // Each group is anchored at its own position: the block right before it, which may be a sibling group's.
      let aPos = i - 1
      let bPos = j - 1
      const first = hunks.length
      groups.forEach(([ga, gb], t) => {
        const beforeBlocks = ga.map(x => blockInfo(a, x))
        const afterBlocks = gb.map(x => blockInfo(b, x))
        const kind = !beforeBlocks.length ? 'add' : !afterBlocks.length ? 'del' : 'change'
        const h = { id: '', kind, section: null, anchor: anchorOf(a, aPos), afterAnchor: anchorOf(b, bPos), context: ctx[t], base, eol: a.eol, beforeBlocks, afterBlocks }
        h.section = sectionFor(h, a, b)
        if (kind === 'change') {
          h.words = wordDiff(beforeBlocks.map(x => plainText(x.text, x.kind)).join('\n'), afterBlocks.map(x => plainText(x.text, x.kind)).join('\n'))
        }
        h.id = hunkId(h, seen)
        hunks.push(h)
        if (ga.length) aPos = ga[ga.length - 1]
        if (gb.length) bPos = gb[gb.length - 1]
      })
      // Siblings of one run sit right next to each other: written in one call, each one's place fixes its neighbour's.
      for (let k = first; k < hunks.length; k++) {
        hunks[k].context.prevId = k > first ? hunks[k - 1].id : null
        hunks[k].context.nextId = k + 1 < hunks.length ? hunks[k + 1].id : null
      }
    }
    i = pi + 1
    j = pj + 1
  }
  return hunks
}

/** A hunk's context; one stored before 0.3.1 has none: its anchor before it (by bytes) and anything after it. */
const contextOf = (h) => h.context ?? { prev: [h.anchor.index < 0 ? TOP : `c:${h.anchor.checksum}`], next: [ANY] }

/**
 * Where each hunk's blocks (`beforeBlocks`: the side being replaced) are in `doc`: Map id -> { at, len } in block
 * units (`len` 0: a gap, insert before block `at`). A run is taken where it is the one match, else the one match whose
 * context fits (both neighbours, else one), never the nearest; a gap likewise between its neighbours. A hunk still
 * ambiguous is placed next to a sibling of its run that was placed in the same call. Unplaced hunks are stale.
 */
function resolve(doc, hunks) {
  const sums = doc.blocks.map((_, i) => sumOf(doc, i))
  const bytes = doc.blocks.map(x => `c:${x.checksum}`)
  const n = sums.length
  const docBase = blockChecksum(sums)
  const at = (set, k) => set.includes(sums[k]) || set.includes(bytes[k])
  const has = (set, k) => set.includes(ANY) || (k < 0 ? set.includes(TOP) : k >= n ? set.includes(END) : at(set, k))
  const narrow = (all, len, ctx) => {
    if (all.length < 2) return all
    const both = all.filter(s => has(ctx.prev, s - 1) && has(ctx.next, s + len))
    if (both.length) return both
    return all.filter(s => has(ctx.prev, s - 1) || has(ctx.next, s + len))
  }
  const items = hunks.map((h) => {
    const ctx = contextOf(h)
    const len = h.beforeBlocks.length
    let all = []
    if (len) {
      const want = h.beforeBlocks.map(x => sumText(x.text))
      for (let s = 0; s + len <= n; s++) if (want.every((w, k) => sums[s + k] === w)) all.push(s)
    } else {
      all = Array.from({ length: n + 1 }, (_, g) => g)
      const full = all.filter(g => has(ctx.prev, g - 1) && has(ctx.next, g))
      // One side moved (a person wrote next to it): the other side alone.
      all = full.length ? all : all.filter(g => (g > 0 && at(ctx.prev, g - 1)) || (g < n && at(ctx.next, g)))
    }
    if (h.base?.[0] === docBase) {
      const exact = len ? h.beforeBlocks[0].index : h.anchor.index + 1
      if (all.includes(exact)) return { h, ctx, len, all, best: [exact] }
    }
    return { h, ctx, len, all, best: narrow(all, len, ctx) }
  })
  const pos = new Map()
  for (const x of items) if (x.best.length === 1) pos.set(x.h.id, { at: x.best[0], len: x.len })
  for (let changed = true; changed;) {
    changed = false
    for (const x of items) {
      if (pos.has(x.h.id)) continue
      const p = x.ctx.prevId ? pos.get(x.ctx.prevId) : null
      const q = x.ctx.nextId ? pos.get(x.ctx.nextId) : null
      if (!p && !q) continue
      const fit = x.all.filter(s => (p && s === p.at + p.len) || (q && s + x.len === q.at))
      if (fit.length === 1) { pos.set(x.h.id, { at: fit[0], len: x.len }); changed = true }
    }
  }
  return pos
}

/** Remove lines [start, end) and the blank lines after them (or before them at the end), keeping a trailing newline. */
function cut(lines, start, end) {
  let s = start
  let e = end
  while (e < lines.length && isBlank(lines[e])) e++
  if (e === lines.length) while (s > 0 && isBlank(lines[s - 1])) s--
  const out = [...lines.slice(0, s), ...lines.slice(e)]
  if (lines.length && lines[lines.length - 1] === '' && out[out.length - 1] !== '' && e === lines.length) out.push('')
  return out
}

/**
 * Write the hunks named by `ids` (all when omitted) into the current `body`. Each is found by its own blocks and
 * context (a delete or change by its before blocks, an add by the gap between its neighbours); one that cannot be found
 * exactly once is skipped as stale. A written block next to a non-blank line gets a blank line so it stays its own
 * block. Returns { text, applied: [ids], stale: [ids] }.
 */
export function applyHunks(body = '', hunks = [], ids = null) {
  const doc = parseDoc(String(body ?? ''))
  const want = ids ? new Set(ids) : null
  const chosen = hunks.filter(h => !want || want.has(h.id))
  const pos = resolve(doc, chosen)
  const placed = []
  const stale = []
  for (const h of chosen) {
    const p = pos.get(h.id)
    if (!p) { stale.push(h.id); continue }
    if (p.len) placed.push({ h, start: doc.blocks[p.at].start, end: doc.blocks[p.at + p.len - 1].end })
    else if (p.at === 0) placed.push({ h, start: 0, end: 0, top: true })
    else placed.push({ h, start: doc.blocks[p.at - 1].end, end: doc.blocks[p.at - 1].end })
  }
  // Two hunks that land on the same lines (only possible after unrelated edits): the second is stale.
  placed.sort((x, y) => x.start - y.start)
  const kept = []
  for (const p of placed) {
    const last = kept[kept.length - 1]
    if (last && p.start < last.end) stale.push(p.h.id)
    else kept.push(p)
  }
  const docEol = doc.lines.some(l => !isBlank(l)) ? doc.eol : null
  let lines = doc.lines
  for (const p of [...kept].reverse()) {
    const eol = docEol ?? p.h.eol ?? doc.eol
    const blank = eol === '\r\n' ? '\r' : ''
    if (!p.h.afterBlocks.length) { lines = cut(lines, p.start, p.end); continue }
    const next = withEol(eol, p.h.afterBlocks.map(x => x.text).join('\n\n').split('\n'))
    const pad = (k) => (k >= 0 && k < lines.length && !isBlank(lines[k]) ? [blank] : [])
    if (p.top) lines = lines.every(isBlank) ? [...next, ''] : [...next, blank, ...lines]
    else lines = [...lines.slice(0, p.start), ...pad(p.start - 1), ...next, ...pad(p.end), ...lines.slice(p.end)]
  }
  return { text: lines.join('\n'), applied: kept.map(p => p.h.id), stale }
}

/** The inverse of a hunk: what undoes it once it is written (its context already holds both sides). */
export function invertHunk(h) {
  const kind = h.kind === 'add' ? 'del' : h.kind === 'del' ? 'add' : 'change'
  return { ...h, kind, anchor: h.afterAnchor, afterAnchor: h.anchor, beforeBlocks: h.afterBlocks, afterBlocks: h.beforeBlocks,
    ...(h.base ? { base: [h.base[1], h.base[0]] } : {}),
    ...(h.words ? { words: h.words.map(x => ({ t: x.t === 'add' ? 'del' : x.t === 'del' ? 'add' : 'eq', w: x.w })) } : {}) }
}

/** Undo the hunks named by `ids` (all when omitted) in a body they were written into. Same result shape as applyHunks. */
export function revertHunks(afterBody = '', hunks = [], ids = null) {
  return applyHunks(afterBody, hunks.map(invertHunk), ids)
}

/**
 * The post-condition callers check before writing hunks: applying all of them to `before` gives `after`, and reverting
 * all of them gives `before` back, block for block (same block texts, in order). { ok, apply, revert }. When it is
 * false the hunks cannot be trusted for this pair, and the caller writes the whole proposed text instead.
 */
export function checkProposal(before = '', after = '', hunks = []) {
  const keys = (text) => { const d = parseDoc(String(text ?? '')); return d.blocks.map((x, i) => keyOf(blockText(d, i), x.kind)) }
  const same = (x, y) => { const p = keys(x); const q = keys(y); return p.length === q.length && p.every((k, i) => k === q[i]) }
  const fwd = applyHunks(before, hunks)
  const apply = !fwd.stale.length && same(fwd.text, after)
  const back = apply ? revertHunks(fwd.text, hunks) : null
  const revert = !!back && !back.stale.length && same(back.text, before)
  return { ok: apply && revert, apply, revert }
}

/**
 * Where each hunk's new blocks are in `body` (a body the hunks are written into, or applyHunks' preview of them):
 * { [id]: { first, last, at } | null }. `first`/`last` are block indices of the new blocks (null for a delete); `at` is
 * the block index the previous text belongs before (ghosts of removed text render there; blocks.length: at the end).
 */
export function locateHunks(body = '', hunks = []) {
  const doc = parseDoc(String(body ?? ''))
  const inv = hunks.map(invertHunk)
  const pos = resolve(doc, inv)
  const out = {}
  for (const h of inv) {
    const p = pos.get(h.id)
    out[h.id] = !p ? null : p.len ? { first: p.at, last: p.at + p.len - 1, at: p.at } : { first: null, last: null, at: p.at }
  }
  return out
}

/** Hunks grouped by their section, in document order: [{ slug, title, ids }]. */
export function proposalSections(hunks = []) {
  const out = []
  for (const h of hunks) {
    const key = h.section?.slug ?? ''
    const last = out[out.length - 1]
    if (last && last.slug === key) last.ids.push(h.id)
    else out.push({ slug: key, title: h.section?.title ?? '', ids: [h.id] })
  }
  return out
}

/** Counts for a label such as "−3 secciones · −420 palabras". */
export function proposalStats(hunks = []) {
  let addedWords = 0
  let removedWords = 0
  const headings = (list) => list.filter(x => x.kind === 'heading').map(x => keyOf(x.text))
  const before = hunks.flatMap(h => headings(h.beforeBlocks))
  const after = hunks.flatMap(h => headings(h.afterBlocks))
  for (const h of hunks) {
    if (h.words) for (const x of h.words) { if (x.t === 'add') addedWords++; else if (x.t === 'del') removedWords++ }
    else {
      addedWords += h.afterBlocks.reduce((n, x) => n + wordCount(plainText(x.text, x.kind)), 0)
      removedWords += h.beforeBlocks.reduce((n, x) => n + wordCount(plainText(x.text, x.kind)), 0)
    }
  }
  return { changes: hunks.length, sections: proposalSections(hunks).length,
    removedSections: before.filter(k => !after.includes(k)).length, addedSections: after.filter(k => !before.includes(k)).length,
    addedWords, removedWords }
}
