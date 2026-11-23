// Hoja assist — pure guards around a chat's writes to a document: the base revision changed, more than half the words
// go, once per message, an open block editor after a server write. Botanic's note-store.cjs (removedShare, the held
// rule of aiPropose) and client/ai-guard.mjs before 0.5.0. No state outside the objects they return.

/** A proposal that would remove more than this share of the document's words is held ("large"). */
export const MAX_AUTO_REMOVED_SHARE = 0.5

const words = (text) => (String(text || '').match(/\S+/g) || []).length

/** The share of the body's words the hunks remove (word marks of a change, the whole blocks of a removal), 0 to 1. */
export function removedShare(body, hunks) {
  const total = words(body)
  if (!total) return 0
  let removed = 0
  for (const hunk of hunks) {
    if (hunk.kind === 'add') continue
    if (Array.isArray(hunk.words) && hunk.words.length) removed += hunk.words.filter((word) => word.t === 'del').length
    else removed += (hunk.beforeBlocks || []).reduce((sum, block) => sum + words(block.text), 0)
  }
  return removed / total
}

/** Whether the hunks remove more than `share` of the body's words. */
export function isLargeRemoval(body, hunks, share = MAX_AUTO_REMOVED_SHARE) {
  return removedShare(body, hunks) > share
}

/** Whether the document moved since the turn was sent: both revisions known and different. */
export function baseChanged(baseRevision, currentRevision) {
  return baseRevision !== undefined && baseRevision !== null && currentRevision !== undefined && currentRevision !== null
    && baseRevision !== currentRevision
}

/**
 * Why an automatic write is held for review instead of written, or null: 'changed' when the document moved since the
 * turn was sent (`baseRevision` against `currentRevision`), 'large' when it removes more than half the words. A write
 * the person clicked (`auto: false`) is never held by these rules.
 */
export function holdReason({ auto = true, baseRevision, currentRevision, body = '', hunks = [], share = MAX_AUTO_REMOVED_SHARE } = {}) {
  if (!auto) return null
  if (baseChanged(baseRevision, currentRevision)) return 'changed'
  if (isLargeRemoval(body, hunks, share)) return 'large'
  return null
}

const key = (...parts) => parts.map((part) => String(part ?? '')).join('|')

/** The once-per-message key of a write: the message and its tool ('proposal', 'replace'). */
export function writeKey(messageId, tool = 'proposal') {
  return `${String(messageId || '')}:${tool === 'replace' ? 'replace' : 'proposal'}`
}

/**
 * Whether a message's write already happened, given the keys written so far (`writeKey`). Keys from before the tool
 * was part of the key are the bare message id, always a proposal.
 */
export function alreadyWritten(keys, messageId, tool = 'proposal') {
  const list = Array.isArray(keys) ? keys : [...(keys || [])]
  return list.includes(writeKey(messageId, tool)) || (tool !== 'replace' && list.includes(String(messageId || '')))
}

/** The answers this page has seen, per document and thread. */
export function createSeen() { return new Set() }

/**
 * Whether the answer row writes a proposal on its own. The latest answer is marked seen the first time it is shown,
 * in any mode, so switching to the edit mode later never writes it; only the edit mode writes, once per answer.
 */
export function shouldAutoPropose(seen, { noteKey, conversationId, messageId, isLatest, aiMode }) {
  if (!noteKey || !conversationId || !messageId || !isLatest) return false
  const id = key(noteKey, conversationId, messageId)
  if (seen.has(id)) return false
  seen.add(id)
  return aiMode === 'edit'
}

/**
 * The document's revision when the person sent a turn, per document and thread: sent with the answer's automatic
 * write, so the host holds it when the document changed while the answer streamed. A turn sent from a new chat (`new`)
 * is found under the thread's id once it has one.
 */
export function createTurnBases() {
  const bases = new Map()
  return {
    record(noteKey, conversationId, bodyRevision) {
      if (!noteKey || !Number.isInteger(bodyRevision)) return
      bases.set(key(noteKey, conversationId || 'new'), bodyRevision)
    },
    get(noteKey, conversationId) {
      if (!noteKey) return undefined
      return bases.get(key(noteKey, conversationId || 'new')) ?? bases.get(key(noteKey, 'new'))
    },
  }
}

/**
 * Where an open block editor goes after the server wrote the body: its block (the same text, the one after its
 * neighbour among twins), else a new block after its neighbour so the draft is never written over another block.
 * `anchor` is { text, prev } as the block and the one before it were when the editor opened.
 */
export function reanchorBlock(anchor, index, blocks) {
  const text = anchor?.text ?? ''
  const prev = anchor?.prev ?? null
  const at = (wanted) => blocks.flatMap((block, i) => (block === wanted ? [i] : []))
  if (blocks[index] === text && (index === 0 || blocks[index - 1] === prev)) return { index }
  const hits = at(text)
  if (hits.length === 1) return { index: hits[0] }
  const afterPrev = hits.filter((i) => i > 0 && blocks[i - 1] === prev)
  if (afterPrev.length === 1) return { index: afterPrev[0] }
  if (hits.length && blocks[index] === text) return { index }
  const neighbour = prev === null ? [] : at(prev)
  if (neighbour.length === 1) return { insertAfter: neighbour[0] }
  return { insertAfter: Math.max(0, blocks.length - 1) }
}
