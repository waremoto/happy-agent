// Hoja menus: the slash menu catalog and the block / section menu model. Pure data plus filters, so every host shows
// the same items in the same order and the chrome only draws them. Labels ship in English and Spanish (Botanic is
// Spanish first); a host may pass its own `t(key, fallback)`.
import { AI_ACTIONS } from './ai.mjs'

export const LABELS = {
  en: {
    paragraph: 'Text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', bullet: 'Bulleted list', ordered: 'Numbered list',
    task: 'To-do list', quote: 'Quote', callout: 'Callout', code: 'Code', mermaid: 'Diagram (Mermaid)', table: 'Table',
    rule: 'Divider', toggleHeading: 'Toggle heading',
    turnInto: 'Turn into', duplicate: 'Duplicate', delete: 'Delete', moveUp: 'Move up', moveDown: 'Move down',
    copyLink: 'Copy link to block', copyMarkdown: 'Copy as Markdown', edit: 'Edit', editHere: 'Edit here',
    collapse: 'Collapse section', expand: 'Expand section', moveSectionUp: 'Move section up', moveSectionDown: 'Move section down',
    duplicateSection: 'Duplicate section', deleteSection: 'Delete section', section: 'Section', block: 'Block', ai: 'AI',
    insertBelow: 'Add a block below', dragHandle: 'Drag to move · click for menu', search: 'Search actions…', noResults: 'No results',
    ai_shorter: 'Summarize shorter', ai_expand: 'Expand', ai_translate: 'Translate', ai_rewrite: 'Improve writing',
    ai_section_shorter: 'Summarize section shorter', blockMenu: 'Block menu', slashMenu: 'Insert block'
  },
  es: {
    paragraph: 'Texto', h1: 'Título 1', h2: 'Título 2', h3: 'Título 3', bullet: 'Lista con viñetas', ordered: 'Lista numerada',
    task: 'Lista de tareas', quote: 'Cita', callout: 'Destacado', code: 'Código', mermaid: 'Diagrama (Mermaid)', table: 'Tabla',
    rule: 'Separador', toggleHeading: 'Título desplegable',
    turnInto: 'Convertir en', duplicate: 'Duplicar', delete: 'Eliminar', moveUp: 'Subir', moveDown: 'Bajar',
    copyLink: 'Copiar enlace al bloque', copyMarkdown: 'Copiar como Markdown', edit: 'Editar', editHere: 'Editar aquí',
    collapse: 'Contraer sección', expand: 'Expandir sección', moveSectionUp: 'Subir sección', moveSectionDown: 'Bajar sección',
    duplicateSection: 'Duplicar sección', deleteSection: 'Eliminar sección', section: 'Sección', block: 'Bloque', ai: 'IA',
    insertBelow: 'Añadir un bloque debajo', dragHandle: 'Arrastra para mover · clic para el menú', search: 'Buscar acciones…', noResults: 'Sin resultados',
    ai_shorter: 'Resumir más corto', ai_expand: 'Ampliar', ai_translate: 'Traducir', ai_rewrite: 'Mejorar redacción',
    ai_section_shorter: 'Resumir la sección más corto', blockMenu: 'Menú del bloque', slashMenu: 'Insertar bloque'
  }
}

/** A label for `key` in `lang` (falls back to English, then the key). */
export function label(key, lang = 'en') {
  const l = String(lang || 'en').slice(0, 2)
  return (LABELS[l] ?? LABELS.en)[key] ?? LABELS.en[key] ?? key
}

/**
 * The slash menu: what `/` offers at a line start. `lines` is the markdown to insert; `caret` is [line, column] inside
 * it where the caret lands.
 */
export const SLASH_ITEMS = [
  { id: 'paragraph', icon: 'T', keywords: 'text paragraph texto parrafo', lines: [''], caret: [0, 0] },
  { id: 'h1', icon: 'H1', keywords: 'heading title h1 titulo encabezado', lines: ['# '], caret: [0, 2] },
  { id: 'h2', icon: 'H2', keywords: 'heading subtitle h2 titulo subtitulo', lines: ['## '], caret: [0, 3] },
  { id: 'h3', icon: 'H3', keywords: 'heading h3 titulo', lines: ['### '], caret: [0, 4] },
  { id: 'bullet', icon: '•', keywords: 'bullet list unordered lista viñetas', lines: ['- '], caret: [0, 2] },
  { id: 'ordered', icon: '1.', keywords: 'numbered ordered list lista numerada', lines: ['1. '], caret: [0, 3] },
  { id: 'task', icon: '☐', keywords: 'todo task checkbox checklist tarea pendiente', lines: ['- [ ] '], caret: [0, 6] },
  { id: 'quote', icon: '❝', keywords: 'quote blockquote cita', lines: ['> '], caret: [0, 2] },
  { id: 'callout', icon: '!', keywords: 'callout note tip warning destacado nota aviso', lines: ['> [!NOTE]', '> '], caret: [1, 2] },
  { id: 'code', icon: '</>', keywords: 'code snippet codigo', lines: ['```', '', '```'], caret: [1, 0] },
  { id: 'mermaid', icon: '◇', keywords: 'diagram mermaid flowchart chart diagrama', lines: ['```mermaid', 'flowchart TD', '  A --> B', '```'], caret: [2, 9] },
  { id: 'table', icon: '▦', keywords: 'table grid tabla', lines: ['| Column | Column |', '| --- | --- |', '|  |  |'], caret: [2, 2] },
  { id: 'rule', icon: '—', keywords: 'divider rule hr line separador linea', lines: ['---'], caret: [0, 3] }
]

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Slash items matching `query` (label in either language, id or keywords), best matches first. */
export function filterSlash(query = '', lang = 'en', items = SLASH_ITEMS) {
  const q = fold(query.trim())
  if (!q) return items
  const scored = []
  for (const it of items) {
    const name = fold(label(it.id, lang))
    const hay = `${name} ${fold(label(it.id, 'en'))} ${it.id} ${fold(it.keywords ?? '')}`
    const score = name.startsWith(q) ? 0 : it.id.startsWith(q) ? 1 : hay.includes(q) ? 2 : -1
    if (score >= 0) scored.push([score, it])
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, it]) => it)
}

const TURNABLE = new Set(['paragraph', 'heading', 'bullet', 'ordered', 'task', 'quote', 'callout', 'code'])

/** The kind id a block shows as in "Turn into" (h1..h3 for headings). */
export function kindId(block) {
  if (!block) return ''
  return block.kind === 'heading' ? `h${Math.min(block.level ?? 1, 3)}` : block.kind
}

/**
 * The block menu for one block: groups of items. Each item: { id, label, group, disabled?, danger?, children? }.
 * `id` is the action the chrome emits (`turn:h2`, `duplicate`, `ai:shorter`, `section:collapse`...).
 * options: { lang, canEdit, ai (array of AI action ids, or false), collapsed (heading only), first, last, extra }.
 */
export function blockMenu(block, options = {}) {
  const { lang = 'en', canEdit = true, ai = false, sectionAi = true, collapsed = false, first = false, last = false, extra = [] } = options
  const t = (k) => label(k, lang)
  const groups = []
  const isHeading = block?.kind === 'heading'
  if (canEdit && TURNABLE.has(block?.kind)) {
    const now = kindId(block)
    groups.push({
      id: 'turn',
      items: [{ id: 'turn', label: t('turnInto'), children: ['paragraph', 'h1', 'h2', 'h3', 'bullet', 'ordered', 'task', 'quote', 'callout', 'code']
        .filter(k => k !== now).map(k => ({ id: `turn:${k}`, label: t(k) })) }]
    })
  }
  if (canEdit) {
    groups.push({
      id: 'block',
      items: [
        { id: 'edit', label: t('edit') },
        { id: 'duplicate', label: t('duplicate') },
        { id: 'move-up', label: t('moveUp'), disabled: first },
        { id: 'move-down', label: t('moveDown'), disabled: last },
        { id: 'delete', label: t('delete'), danger: true }
      ]
    })
  }
  if (isHeading) {
    groups.push({
      id: 'section',
      label: t('section'),
      items: [
        { id: collapsed ? 'section:expand' : 'section:collapse', label: t(collapsed ? 'expand' : 'collapse') },
        ...(canEdit ? [
          { id: 'section:move-up', label: t('moveSectionUp'), disabled: first },
          { id: 'section:move-down', label: t('moveSectionDown') },
          { id: 'section:duplicate', label: t('duplicateSection') },
          { id: 'section:delete', label: t('deleteSection'), danger: true }
        ] : [])
      ]
    })
  }
  groups.push({ id: 'copy', items: [{ id: 'copy-link', label: t('copyLink') }, { id: 'copy-markdown', label: t('copyMarkdown') }] })
  const actions = Array.isArray(ai) ? ai.filter(a => AI_ACTIONS[a]?.target === 'block') : []
  if (actions.length && block && !['rule', 'frontmatter', 'embed'].includes(block.kind)) {
    groups.push({
      id: 'ai',
      label: t('ai'),
      items: [
        ...actions.map(a => ({ id: `ai:${a}`, label: t(`ai_${a}`), ai: true })),
        ...(isHeading && sectionAi && actions.includes('shorter') ? [{ id: 'ai:section-shorter', label: t('ai_section_shorter'), ai: true }] : [])
      ]
    })
  }
  if (extra.length) groups.push({ id: 'extra', items: extra })
  return groups.filter(g => g.items.length)
}

/** Every leaf item of a menu, flattened (children included), for search and keyboard navigation. */
export function menuItems(groups) {
  const out = []
  for (const g of groups) for (const it of g.items) {
    if (it.children) for (const c of it.children) out.push({ ...c, parent: it.label })
    else out.push(it)
  }
  return out
}

/** Menu leaves whose label contains `query` (accent-insensitive). */
export function filterMenu(groups, query = '') {
  const q = fold(query.trim())
  const all = menuItems(groups)
  return q ? all.filter(it => fold(`${it.parent ?? ''} ${it.label}`).includes(q)) : all
}
