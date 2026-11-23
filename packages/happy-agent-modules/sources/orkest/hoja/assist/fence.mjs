// Hoja assist — fenced blocks in a chat answer: ```propuesta (the whole proposed document) and ```documento title="…"
// (a new, separate document). One extractor for every host (Botanic's fence-block.cjs/.mjs and Orkest's
// orkestExtractProposal before 0.5.0). Pure and linear in the text; zero dependencies.

/** Longest answer text read (4 × Botanic's 50,000-character note limit): what is past it is never parsed. */
export const MAX_ANSWER_TEXT = 200_000
const FENCE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/

/** The fence names of each kind of block (the Spanish name is the contract; the English one is accepted). */
export const PROPOSAL_FENCES = ['propuesta']
export const DOCUMENT_FENCES = ['documento', 'document']

/**
 * The first block opened by a fence line whose info string starts with one of `names` (```propuesta, ````propuesta,
 * ~~~documento title="…"). Inner code blocks are paired: an inner opener with an info string, or a bare fence that
 * cannot close the block (other character, shorter), opens one, closed by the next bare fence of its kind. The block
 * ends at the first bare fence of the opener's kind and length or longer outside an inner block; text after it is
 * not part of the block. An unclosed block (an answer cut short) runs to the end.
 * Returns { name, attrs, body, before, closed } or null. Every step is linear in the text.
 */
export function fencedBlock(text, names) {
  const source = String(text || '').slice(0, MAX_ANSWER_TEXT).replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i])
    const info = open ? open[2].trim() : ''
    const name = info.split(/[ \t]/)[0].toLowerCase()
    if (!open || !names.includes(name) || (open[1][0] === '`' && open[2].includes('`'))) { offset += lines[i].length + 1; continue }
    const char = open[1][0]
    const length = open[1].length
    const inner = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const fence = FENCE.exec(lines[j])
      if (!fence) continue
      const fenceChar = fence[1][0]
      const fenceLength = fence[1].length
      const bare = !fence[2].trim()
      if (inner.length) {
        const top = inner[inner.length - 1]
        if (bare && fenceChar === top.char && fenceLength >= top.length) inner.pop()
        continue
      }
      if (bare && fenceChar === char && fenceLength >= length) {
        return { name, attrs: info.slice(name.length).trim(), body: lines.slice(i + 1, j).join('\n'), before: source.slice(0, offset), closed: true }
      }
      inner.push({ char: fenceChar, length: fenceLength })
    }
    return { name, attrs: info.slice(name.length).trim(), body: lines.slice(i + 1).join('\n'), before: source.slice(0, offset), closed: false }
  }
  return null
}

/**
 * { why, markdown, closed } from an answer holding a ```propuesta block, else null: the prose before the block is the
 * why; the block ends at its own closing fence (prose or a later code block after it never lands in the document).
 */
export function extractProposal(answer) {
  const block = fencedBlock(answer, PROPOSAL_FENCES)
  if (!block) return null
  const body = block.body.trimEnd()
  if (!body.trim()) return null
  return { why: block.before.trim(), markdown: body + '\n', closed: block.closed }
}

const plainTitle = (text) => String(text || '').replace(/[*_`#]/g, '').trim().toLowerCase()

/**
 * The proposed document as the host's body would hold it: leading blank lines dropped, one final newline, and a
 * leading `# <title>` dropped when the body does not start with a heading (a host that keeps the title apart, such as
 * Botanic's note). With no `title` only the whitespace rule applies.
 */
export function proposalDocument(markdown, { title = '', body = '' } = {}) {
  let text = String(markdown || '').replace(/\r\n?/g, '\n').replace(/^\n+/, '')
  const first = title ? /^#[ \t]+(.+)\n*/.exec(text) : null
  if (first && plainTitle(first[1]) === plainTitle(title) && !/^#[ \t]/.test(String(body || '').trimStart())) text = text.slice(first[0].length)
  return text.trimEnd() + '\n'
}

/** The whole proposed document of an answer (extractProposal, then proposalDocument), or null when there is none. */
export function proposalFromAnswer(answer, title = '', body = '') {
  const got = extractProposal(answer)
  if (!got) return null
  const text = proposalDocument(got.markdown, { title, body })
  return text.trim() ? text : null
}

/**
 * A new document from an answer: the ```documento block (else the whole answer), trimmed, and its title from the
 * fence's `title="…"`, else its first heading. { markdown, title, fenced }.
 */
export function documentFromAnswer(answer) {
  const value = String(answer || '').slice(0, MAX_ANSWER_TEXT)
  const block = fencedBlock(value, DOCUMENT_FENCES)
  const markdown = (block ? block.body : value).trim()
  const heading = /^#{1,3}[ \t]+(.+)$/m.exec(markdown)?.[1]
  const titled = block?.attrs && /title|titulo|título/i.test(block.attrs) ? /["“]([^"”]+)["”]/.exec(block.attrs)?.[1] : ''
  return { markdown, title: titled || heading || '', fenced: !!block }
}
