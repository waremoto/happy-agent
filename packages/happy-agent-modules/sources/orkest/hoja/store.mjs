// Hoja storage seam. Git is the source of truth: Orkest stores docs in a repository (gitd reads, room saves as commits,
// edit branches as drafts); Botanic stores notes in Mongo with a revision and a history (the same shape, so notes can
// move to git later by swapping the store). Yjs is a live session only and never a store.
//
// interface HojaStore {
//   read(path) → { text, revision }
//   write(path, text, { base, message, actor }) → { revision }       refuses (409) when `base` is not the current revision
//   versions(path, { limit }) → [{ id, at, actor: { kind: 'human'|'ai'|'agent', name, model? }, name?, message? }]
//   version(path, id) → { id, text, ... }
//   blame(path, blocks) → [{ actor, at } | null] per block
//   name?(path, id, name)      named versions (a git tag, a history label)
//   draft?(path) → { branch }  branches as drafts
// }
//
// interface HojaConnector (the Notion seam; not built): pull(pageId) → markdown · push(markdown, pageId) · link(path, pageId).
// A pull lands as a write whose actor is the connector, so git and blame still hold. A connector is never the store.

export const STORE_METHODS = ['read', 'write', 'versions', 'version', 'blame']
export const CONNECTOR_METHODS = ['pull', 'push', 'link']

/** The methods `store` lacks (an empty list means it implements HojaStore). */
export function missingMethods(store, methods = STORE_METHODS) {
  return methods.filter(m => typeof store?.[m] !== 'function')
}

function conflict() {
  return Object.assign(new Error('revision_conflict'), { status: 409, code: 'revision_conflict' })
}

/** An in-memory HojaStore (tests, previews). Revisions count up; every write is a version. */
export function memoryStore(initial = {}) {
  const docs = new Map()
  const clock = () => new Date().toISOString()
  for (const [path, text] of Object.entries(initial)) docs.set(path, [{ id: '1', text, at: clock(), actor: { kind: 'human', name: 'seed' } }])
  const head = (path) => docs.get(path)?.at(-1) ?? null
  return {
    async read(path) {
      const h = head(path)
      return { text: h?.text ?? '', revision: h?.id ?? '0' }
    },
    async write(path, text, { base, message = '', actor = { kind: 'human', name: 'unknown' } } = {}) {
      const h = head(path)
      if ((h?.id ?? '0') !== String(base)) throw conflict()
      const list = docs.get(path) ?? []
      const v = { id: String(list.length + 1), text: String(text), at: clock(), actor, message }
      docs.set(path, [...list, v])
      return { revision: v.id }
    },
    async versions(path, { limit = 50 } = {}) {
      return (docs.get(path) ?? []).slice().reverse().slice(0, limit).map(({ text, ...v }) => v)
    },
    async version(path, id) {
      const v = (docs.get(path) ?? []).find(x => x.id === String(id))
      if (!v) throw Object.assign(new Error('version_not_found'), { status: 404 })
      return v
    },
    async blame(path, blocks) {
      const list = docs.get(path) ?? []
      // A block's author is the first version, from the newest backwards, whose text no longer contains the block.
      return blocks.map(b => {
        const text = typeof b === 'string' ? b : b.text
        let author = null
        for (let i = list.length - 1; i >= 0; i--) {
          if (!list[i].text.includes(text)) break
          author = { actor: list[i].actor, at: list[i].at, id: list[i].id }
        }
        return author
      })
    },
    async name(path, id, name) {
      const v = (docs.get(path) ?? []).find(x => x.id === String(id))
      if (v) v.name = String(name).slice(0, 80)
    }
  }
}
