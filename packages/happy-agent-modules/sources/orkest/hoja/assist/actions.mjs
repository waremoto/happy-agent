// Hoja assist — quick actions: chat turns a host offers as buttons beside its document (Botanic's Studio buttons,
// Orkest's dock). A small shared catalogue; each host extends it with its own (Botanic's video actions, Orkest's
// Reconcile roadmap) through `extendActions`. An action is { id, label: { en, es }, prompt: { en, es }, proposes }:
// `proposes` says the answer is a document proposal (contract.mjs), else a plain chat answer.

export const ASSIST_ACTIONS = Object.freeze([
  {
    id: 'shorter',
    proposes: true,
    label: { en: 'Make it shorter', es: 'Acortar' },
    prompt: {
      en: 'Propose this document shorter: keep every heading, fact, number, name and link, cut repetition and filler, and leave sections that are already short as they are.',
      es: 'Propón este documento más corto: conserva cada título, dato, número, nombre y enlace, quita repeticiones y relleno, y deja como están las secciones que ya son cortas.',
    },
  },
  {
    id: 'clean-up',
    proposes: true,
    label: { en: 'Clean up', es: 'Limpiar' },
    prompt: {
      en: 'Propose this document cleaned up: fix spelling, grammar and broken markdown, make headings consistent, and change nothing else.',
      es: 'Propón este documento limpio: corrige ortografía, gramática y markdown roto, deja los títulos consistentes y no cambies nada más.',
    },
  },
  {
    id: 'not-needed',
    proposes: true,
    label: { en: 'What can go?', es: '¿Qué sobra?' },
    prompt: {
      en: 'Which parts of this document are not needed? Propose the document without them and say in one sentence why each one goes.',
      es: '¿Qué partes de este documento sobran? Propón el documento sin ellas y di en una frase por qué se va cada una.',
    },
  },
  {
    id: 'translate',
    proposes: true,
    label: { en: 'Translate', es: 'Traducir' },
    prompt: {
      en: 'Propose this document translated into {target}. Keep the markdown, the code blocks, the links and every container line exactly as they are.',
      es: 'Propón este documento traducido al {target}. Mantén tal cual el markdown, los bloques de código, los enlaces y cada línea de contenedor.',
    },
  },
  {
    id: 'summary',
    proposes: false,
    label: { en: 'Summary', es: 'Resumen' },
    prompt: {
      en: 'Summarize this document. Start with a one-sentence **TL;DR:** line, then 3 to 6 bullets with the key points, each naming its section.',
      es: 'Resume este documento. Empieza con una línea **TL;DR:** de una frase y sigue con 3 a 6 viñetas con las ideas clave, cada una con el nombre de su sección.',
    },
  },
])

const TARGET = { en: { en: 'English', es: 'Spanish' }, es: { en: 'inglés', es: 'español' } }

/**
 * The catalogue with a host's actions added: an action whose id is already there replaces it in place (a host may
 * reword a shared action), new ones go at the end. Each action needs an id and an English label and prompt.
 */
export function extendActions(base = ASSIST_ACTIONS, extra = []) {
  const out = base.map((action) => ({ ...action }))
  for (const action of extra) {
    if (!action?.id || !action.label?.en || !action.prompt?.en) throw new Error(`hoja assist: an action needs id, label.en and prompt.en (${action?.id ?? '?'})`)
    const at = out.findIndex((a) => a.id === action.id)
    const value = { proposes: false, ...action }
    if (at >= 0) out[at] = value
    else out.push(value)
  }
  return out
}

/** The action `id` of `catalogue`, or null. */
export function findAction(catalogue, id) {
  return catalogue.find((action) => action.id === id) ?? null
}

/**
 * The chat turn of action `id` in `lang` ('en' | 'es', English when the action has no such text), with `{name}`
 * placeholders filled from `vars` ({target} defaults to the other language's name). null for an unknown id.
 */
export function actionPrompt(catalogue, id, { lang = 'en', vars = {} } = {}) {
  const action = findAction(catalogue, id)
  if (!action) return null
  const text = action.prompt[lang] ?? action.prompt.en
  const names = TARGET[lang] ?? TARGET.en
  const values = { target: lang === 'es' ? names.en : names.es, ...vars }
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
}

/** The action's label in `lang`, English when it has no such label. */
export function actionLabel(action, lang = 'en') {
  return action?.label?.[lang] ?? action?.label?.en ?? ''
}
