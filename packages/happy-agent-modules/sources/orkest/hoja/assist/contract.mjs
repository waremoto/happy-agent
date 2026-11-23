// Hoja assist — the document-session contract: what a chat is told about proposing a change to its document. One text
// for every host, parameterised by how the proposal travels and by language:
//   host 'fence' — the answer carries the whole new document in a ```propuesta block (Botanic on LibreChat, Orkest's
//                  "Propose changes" click);
//   host 'tool'  — the agent edits a working copy and calls a tool; the host reads the file and sends it whole
//                  (Orkest's Happy session). The rule is the same: the whole document, never a patch.
// Botanic's NOTE_WORKSPACE and Orkest's DOC_PROPOSAL_PROMPT before 0.5.0. Host-specific lines (buttons, product names)
// stay the host's and go in `extra`.
// 0.5.1: every host keeps video timestamps ([m:ss], [h:mm:ss]) and never invents one (Botanic's notes cite their video
// that way; Orkest's project session reads those notes as project docs, its stage 7).

const TEXT = {
  en: {
    when: 'When the person asks you to change the document itself (shorten it, summarize it to half, clean it up, reorder, restructure, translate or fix it, or asks which part is not needed or what can go), do not only describe the change: propose the complete new document.',
    fence: (open, close) => `Answer with at most two sentences saying what you changed and why, then the COMPLETE new document inside one fenced block that opens with ${open}propuesta on its own line and closes with ${close} on its own line.`,
    fenceLong: ' When the document contains ``` code blocks, open with ````propuesta and close with ````.',
    tool: (path, tool) => `Make the change in the working copy ${path} with your file tools, keeping it the whole document, then call ${tool} with the document's path and one sentence saying what you changed and why. The app reads the whole working copy and shows the change; never paste the document, a patch or a diff in the chat.`,
    keep: 'Copy every part you were not asked to change byte for byte (same headings, same wording, same markdown, same blank lines, same order), so the change stays small. Keep the document\'s language unless asked to translate; keep every fact, number, name and link you keep; add nothing that is not in the document or its sources unless asked.',
    timestamps: 'Timestamps like [0:42] or [1:02:03] cite a moment of the document\'s video: keep each one exactly as written, on the line it belongs to, never change or invent one, and add one only when the person gives it or the sources carry it.',
    notNeeded: 'When the question is which part is not needed, remove those sections in the proposed document instead of listing them.',
    neverPatch: 'Never answer with a patch, a diff or only part of the document.',
    fenceOnlyChange: 'Never use ```propuesta for answers about the document that do not change it.',
    fenceNewDoc: ' A new, separate document is not a proposal: write it inside one fenced block that opens with ```documento title="<title>" and closes with ```.',
    toolOnlyChange: (tool) => `Do not call ${tool} for answers about the document that do not change it; answer in prose.`,
    containers: 'The document may hold containers: a line "::: toggle <title>" opens a collapsible section, a line "::: indent" opens an indented group, and a line ":::" closes either. Keep those lines exactly as they are.',
    modes: 'aiMode in the reference data says what happens to a proposal: edit means it is written as soon as you finish and the person can undo it; suggest means the person reviews it first; view means the document cannot change, so answer in prose and say that the document is read only.',
    review: 'A person reviews every proposal and accepts it whole or section by section; nothing is written until they do. Say what you proposed; never say the document is already changed.',
    outline: 'outline in the reference data lists the document\'s sections (heading, level, block range, words); use it to name sections precisely.',
    language: 'Answer in the language of the person.',
  },
  es: {
    when: 'Cuando la persona pida cambiar el documento mismo (acortarlo, resumirlo a la mitad, limpiarlo, reordenarlo, reestructurarlo, traducirlo o corregirlo, o pregunte qué parte sobra o qué se puede quitar), no te limites a describir el cambio: propón el documento nuevo completo.',
    fence: (open, close) => `Responde con un máximo de dos frases que digan qué cambiaste y por qué, y luego el documento nuevo COMPLETO dentro de un solo bloque que abre con ${open}propuesta en su propia línea y cierra con ${close} en su propia línea.`,
    fenceLong: ' Si el documento contiene bloques de código ```, abre con ````propuesta y cierra con ````.',
    tool: (path, tool) => `Haz el cambio en la copia de trabajo ${path} con tus herramientas de archivos, manteniendo el documento completo, y luego llama a ${tool} con la ruta del documento y una frase que diga qué cambiaste y por qué. La aplicación lee la copia de trabajo completa y muestra el cambio; nunca pegues en el chat el documento, un parche ni un diff.`,
    keep: 'Copia byte a byte cada parte que no te pidieron cambiar (mismos títulos, mismas palabras, mismo markdown, mismas líneas en blanco, mismo orden), para que el cambio sea pequeño. Mantén el idioma del documento salvo que pidan traducirlo; conserva cada dato, número, nombre y enlace que mantengas; no agregues nada que no esté en el documento o en sus fuentes salvo que lo pidan.',
    timestamps: 'Las marcas de tiempo como [0:42] o [1:02:03] citan un momento del video del documento: mantén cada una tal como está escrita, en la línea a la que pertenece, nunca cambies ni inventes una, y agrega una solo cuando la persona la dé o las fuentes la traigan.',
    notNeeded: 'Cuando la pregunta sea qué parte sobra, quita esas secciones en el documento propuesto en vez de listarlas.',
    neverPatch: 'Nunca respondas con un parche, un diff o solo una parte del documento.',
    fenceOnlyChange: 'Nunca uses ```propuesta para respuestas sobre el documento que no lo cambian.',
    fenceNewDoc: ' Un documento nuevo y separado no es una propuesta: escríbelo dentro de un solo bloque que abre con ```documento title="<título>" y cierra con ```.',
    toolOnlyChange: (tool) => `No llames a ${tool} para respuestas sobre el documento que no lo cambian; responde en texto.`,
    containers: 'El documento puede tener contenedores: una línea "::: toggle <título>" abre una sección plegable, una línea "::: indent" abre un grupo con sangría y una línea ":::" cierra cualquiera de los dos. Mantén esas líneas tal como están.',
    modes: 'aiMode en los datos de referencia dice qué pasa con una propuesta: edit significa que se escribe apenas termines y la persona puede deshacerla; suggest significa que la persona la revisa antes; view significa que el documento no puede cambiar, así que responde en texto y di que el documento es de solo lectura.',
    review: 'Una persona revisa cada propuesta y la acepta entera o sección por sección; nada se escribe hasta que lo haga. Di qué propusiste; nunca digas que el documento ya cambió.',
    outline: 'outline en los datos de referencia lista las secciones del documento (título, nivel, rango de bloques, palabras); úsalo para nombrar secciones con precisión.',
    language: 'Responde en el idioma de la persona.',
  },
}

/** The languages the contract is written in. */
export const CONTRACT_LANGUAGES = Object.keys(TEXT)

/**
 * The contract text, one paragraph. Options:
 *   host        'fence' (default) | 'tool'
 *   lang        'en' (default) | 'es' — the language the contract is written in (the chat answers in the person's)
 *   longFence   fence host: always open with ````propuesta (a host that quotes the document in ``` blocks)
 *   documents   fence host: also explain ```documento title="…" for a new, separate document
 *   tool        tool host: the tool's name (default 'propose_document')
 *   workingCopy tool host: where the working copy is (default 'doc/<file>.md')
 *   modes       true: the host has Botanic's edit / suggest / view modes in the reference data (aiMode); false
 *               (default): a person reviews and accepts every proposal (Orkest, D-22)
 *   outline     true: the reference data carries `outline` (context.mjs documentOutline)
 *   language    true (default): answer in the person's language
 *   intro       host lines put first (who the assistant is); extra: host lines put last (its buttons, its tools)
 */
export function documentContract({ host = 'fence', lang = 'en', longFence = false, documents = false, tool = 'propose_document', workingCopy = 'doc/<file>.md',
  modes = false, outline = false, language = true, intro = '', extra = '' } = {}) {
  const t = TEXT[lang] ?? TEXT.en
  if (host !== 'fence' && host !== 'tool') throw new Error(`hoja assist: unknown contract host ${host}`)
  const parts = [intro, t.when]
  if (host === 'fence') {
    parts.push(longFence ? t.fence('````', '````') : t.fence('```', '```') + t.fenceLong)
  } else {
    parts.push(t.tool(workingCopy, tool))
  }
  parts.push(t.keep, t.timestamps, t.notNeeded, t.neverPatch)
  parts.push(host === 'fence' ? t.fenceOnlyChange + (documents ? t.fenceNewDoc : '') : t.toolOnlyChange(tool))
  parts.push(t.containers, modes ? t.modes : t.review)
  if (outline) parts.push(t.outline)
  if (language) parts.push(t.language)
  parts.push(extra)
  return parts.filter(Boolean).join(' ')
}
