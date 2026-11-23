// Hoja assist — what a host draws for a document proposal: where each hunk's marks go, the composite "new text plus
// previous text" view, and the summary counts. Botanic's proposal-view.mjs and Orkest's orkestProposalView before
// 0.5.0. The diff is Hoja's (proposal.mjs); the renderers stay the host's (React in Botanic, Vue in Orkest).
import { blockText, parseDoc } from '../blocks.mjs'
import { locateHunks, plainText, proposalSections, proposalStats } from '../proposal.mjs'

const isEs = (lang) => lang === true || lang === 'es'

/**
 * Where every hunk goes in the shown body (stale hunks are left out):
 *   marks    — block index → { hunk, mark: 'new' (whole block) | 'changed' (word marks) };
 *   previous — block index → hunks whose previous text belongs right before that block (blocks.length: at the end);
 *   chips    — block index → the section ({ slug, title, ids }) whose chip sits on top of that row.
 */
export function proposalPlan(body, hunks) {
  const where = locateHunks(body, hunks)
  const marks = new Map()
  const previous = new Map()
  const first = new Map()
  for (const hunk of hunks) {
    const at = where[hunk.id]
    if (!at) continue
    if (at.first !== null && at.last !== null) {
      const mark = hunk.kind === 'change' && hunk.words?.some((w) => w.t === 'eq') ? 'changed' : 'new'
      for (let k = at.first; k <= at.last; k += 1) marks.set(k, { hunk, mark })
    }
    if (hunk.beforeBlocks.length) previous.set(at.at, [...(previous.get(at.at) || []), hunk])
    first.set(hunk.id, at.at)
  }
  const chips = new Map()
  for (const section of proposalSections(hunks)) {
    const ids = section.ids.filter((id) => first.has(id))
    if (!ids.length) continue
    const at = Math.min(...ids.map((id) => first.get(id)))
    const taken = chips.get(at)
    chips.set(at, taken ? { ...taken, ids: [...taken.ids, ...ids] } : { ...section, ids })
  }
  return { marks, previous, chips }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * "−1 sección · −5 palabras", "3 changes · +40 words": the answer row's and the bar's summary. `lang` is 'es' or 'en'
 * (a boolean is read as Botanic's `es` flag).
 */
export function proposalSummary(hunks, lang = 'es') {
  const s = proposalStats(hunks)
  const es = isEs(lang)
  const l = (spanish, english) => (es ? spanish : english)
  const parts = []
  if (s.removedSections) parts.push('−' + count(s.removedSections, l('sección', 'section'), l('secciones', 'sections')))
  if (s.addedSections) parts.push('+' + count(s.addedSections, l('sección', 'section'), l('secciones', 'sections')))
  if (!parts.length) parts.push(count(s.changes, l('cambio', 'change'), l('cambios', 'changes')))
  const net = s.addedWords - s.removedWords
  if (net) parts.push((net > 0 ? '+' : '−') + count(Math.abs(net), l('palabra', 'word'), l('palabras', 'words')))
  return parts.join(' · ')
}

const wordCount = (text) => (text.match(/\S+/g) ?? []).length
const escapeMd = (text) => text.replace(/([\\`*_[\]<>#|~])/g, '\\$1')

/** The quiet line a removed block leaves: "Removed “Annex” · 8 words" / "Se quitó “Anexo” · 8 palabras". */
export function goneLabel(hunk, lang = 'en') {
  const es = isEs(lang)
  const first = hunk.beforeBlocks[0]
  const words = hunk.beforeBlocks.reduce((n, b) => n + wordCount(plainText(b.text, b.kind)), 0)
  const plain = first ? plainText(first.text, first.kind).replace(/\s+/g, ' ').trim() : ''
  const title = first?.kind === 'heading' ? plain : plain.split(' ').slice(0, 6).join(' ') + (wordCount(plain) > 6 ? '…' : '')
  return `${es ? 'Se quitó' : 'Removed'} “${title}” · ${count(words, es ? 'palabra' : 'word', es ? 'palabras' : 'words')}`
}

/** The quiet line of a change that only removes words: "Removed 3 words" / "Se quitaron 3 palabras". */
export function removedWordsLabel(n, lang = 'en') {
  if (isEs(lang)) return n === 1 ? 'Se quitó 1 palabra' : `Se quitaron ${n} palabras`
  return `Removed ${count(n, 'word', 'words')}`
}

/**
 * The document to render while a proposal is on screen: `after` (the proposed text while pending, the current text
 * once applied) with each changed block marked `new`, and before it the previous text: as `old` ghosts with
 * `showPrevious`, else one `gone` line where a removal was, or where a change only removed words (so no change is
 * invisible while "Show previous" is off).
 * Returns { markdown, entries: [{ role: 'same'|'new'|'old'|'gone', start, end, hunk?, words?, label? }], at(line) }.
 */
export function proposalView(after, hunks, showPrevious, { lang = 'en' } = {}) {
  const doc = parseDoc(after)
  const places = locateHunks(after, hunks)
  const role = doc.blocks.map(() => ({ role: 'same' }))
  const ghosts = new Map()
  for (const h of hunks) {
    const place = places[h.id]
    if (!place) continue
    if (place.first !== null && place.last !== null) {
      for (let k = place.first; k <= place.last; k++) role[k] = { role: 'new', hunk: h.id, ...(h.kind === 'change' ? { words: h.words } : {}) }
    }
    const list = ghosts.get(place.at) ?? []
    if (showPrevious) {
      for (const b of h.beforeBlocks) list.push({ text: b.text, role: 'old', hunk: h.id, ...(h.kind === 'change' ? { words: h.words } : {}) })
    } else if (h.kind === 'del') {
      const label = goneLabel(h, lang)
      list.push({ text: escapeMd(label), role: 'gone', hunk: h.id, label })
    } else if (h.words && !h.words.some(x => x.t === 'add')) {
      const label = removedWordsLabel(h.words.filter(x => x.t === 'del').length, lang)
      list.push({ text: escapeMd(label), role: 'gone', hunk: h.id, label })
    }
    if (list.length) ghosts.set(place.at, list)
  }
  const parts = []
  const entries = []
  let line = 0
  const push = (text, e) => {
    const n = text.split('\n').length
    entries.push({ ...e, start: line, end: line + n })
    parts.push(text)
    line += n + 1
  }
  for (let k = 0; k <= doc.blocks.length; k++) {
    for (const g of ghosts.get(k) ?? []) push(g.text, { role: g.role, hunk: g.hunk, ...(g.words ? { words: g.words } : {}), ...(g.label ? { label: g.label } : {}) })
    if (k < doc.blocks.length) push(blockText(doc, k), role[k])
  }
  const markdown = parts.join('\n\n') + '\n'
  return { markdown, entries, at: (l) => entries.find(e => l >= e.start && l < e.end) ?? null }
}

/** The words of one side of a change, each marked when it is new (`new`) or removed (`old`). */
export function proposalWordMarks(words, side) {
  return side === 'new'
    ? words.filter(x => x.t !== 'del').map(x => ({ w: x.w, mark: x.t === 'add' }))
    : words.filter(x => x.t !== 'add').map(x => ({ w: x.w, mark: x.t === 'del' }))
}
