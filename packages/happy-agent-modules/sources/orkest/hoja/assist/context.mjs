// Hoja assist — what a chat is told about its document: the outline (headings with block ranges and words) and the
// reference data as JSON within a budget, each field within its own share, written stable-first so a provider's
// prompt cache keeps the long parts when only the document changed. Botanic's noteOutline and contextJson before 0.5.0.
import { blockText, outline, parseDoc, sectionOf } from '../blocks.mjs'

/** The document's sections for a chat: [{ heading, level, blocks: '<first>-<last>' (1-based, inclusive), words }]. */
export function documentOutline(body) {
  const doc = parseDoc(String(body || ''))
  return outline(doc).map((item) => {
    const section = sectionOf(doc, item.index)
    let words = 0
    for (let k = section.first + 1; k <= section.last; k += 1) words += (blockText(doc, k).match(/\S+/g) || []).length
    return { heading: item.text, level: item.level, blocks: `${section.first + 1}-${section.last + 1}`, words }
  })
}

/** The reference data's default limit, in JSON characters. */
export const MAX_CONTEXT = 128_000
/** What the chat needs first (the facts), then the document, then its sources; the `rest` field takes what is left. */
export const CONTEXT_ORDER = ['aiMode', 'outline', 'fuentes', 'title', 'body', 'annotation', 'summary', 'savedDocuments', 'page', 'url', 'links', 'videoDescription', 'chapters', 'transcript']
export const CONTEXT_BUDGETS = { aiMode: 40, outline: 8000, fuentes: 6000, title: 600, body: 52_000, annotation: 8000, summary: 8000, savedDocuments: 26_000,
  page: 26_000, url: 2200, links: 4000, videoDescription: 8000, chapters: 6000 }
/** The order the data is written in: what changes least comes first (the mode, small and rarely changed, stays first). */
export const CACHE_ORDER = ['aiMode', 'url', 'links', 'page', 'videoDescription', 'chapters', 'transcript', 'transcriptNote', 'title', 'annotation', 'summary', 'fuentes', 'savedDocuments', 'body', 'outline']

const size = (value) => JSON.stringify(value).length

/** `value` cut to at most `budget` JSON characters: an array by whole items, a string by characters, an object field by field. */
export function fitValue(value, budget) {
  if (budget <= 2) return undefined
  if (size(value) <= budget) return value
  if (typeof value === 'string') {
    let length = Math.min(value.length, budget)
    let cut = value.slice(0, length)
    while (length > 0 && size(cut) > budget) { length = Math.floor(length * budget / size(cut)) - 1; cut = value.slice(0, Math.max(0, length)) }
    return cut
  }
  if (Array.isArray(value)) {
    const kept = []
    let used = 2
    for (const item of value) {
      const next = size(item) + 1
      if (used + next > budget) break
      kept.push(item)
      used += next
    }
    return kept
  }
  if (value && typeof value === 'object') {
    const out = {}
    let left = budget - 2
    const entries = Object.entries(value).sort(([, a], [, b]) => size(a) - size(b))
    for (const [key, item] of entries) {
      const room = left - size(key) - 2
      const fitted = fitValue(item, Math.floor(room / Math.max(1, entries.length - Object.keys(out).length)) || room)
      if (fitted === undefined) continue
      out[key] = fitted
      left -= size(key) + 2 + size(fitted)
    }
    return Object.fromEntries(Object.keys(value).filter((key) => key in out).map((key) => [key, out[key]]))
  }
  return undefined
}

/**
 * The reference data as JSON within `max`: the fields of `order` first, each within its own budget (`budgets`, 4000
 * for an unknown field), the `rest` field (Botanic's transcript) last with the room that is left, with a
 * `<rest>Note` when it was cut. The text is written in `cacheOrder` (stable first). Always valid JSON.
 * Options: { order, budgets, cacheOrder, rest } — Botanic's note fields by default; a host passes its own.
 */
export function contextJson(context, max = MAX_CONTEXT, { order = CONTEXT_ORDER, budgets = CONTEXT_BUDGETS, cacheOrder = CACHE_ORDER, rest = 'transcript' } = {}) {
  const keys = [...order.filter((key) => context[key] !== undefined), ...Object.keys(context).filter((key) => !order.includes(key) && context[key] !== undefined)]
  const out = {}
  let used = 2
  const reserve = 200
  for (const key of keys) {
    const room = max - used - reserve - size(key) - 2
    const budget = key === rest ? room : Math.min(budgets[key] ?? 4000, room)
    const value = fitValue(context[key], budget)
    if (value === undefined) continue
    out[key] = value
    used += size(key) + 2 + size(value)
  }
  const whole = context[rest]
  const note = `${rest}Note`
  if (Array.isArray(whole) && Array.isArray(out[rest]) && out[rest].length < whole.length)
    out[note] = `Only the first ${out[rest].length} of ${whole.length} ${rest} segments fit; say so if the answer needs a later part.`
  else if (typeof whole === 'string' && typeof out[rest] === 'string' && out[rest].length < whole.length)
    out[note] = `Only the first ${out[rest].length} of ${whole.length} ${rest} characters fit.`
  const ordered = {}
  for (const key of [...cacheOrder, ...Object.keys(out)]) if (out[key] !== undefined && !(key in ordered)) ordered[key] = out[key]
  const text = JSON.stringify(ordered)
  return text.length <= max ? text : JSON.stringify({ aiMode: out.aiMode, outline: fitValue(out.outline || [], Math.floor(max / 2)), title: out.title })
}
