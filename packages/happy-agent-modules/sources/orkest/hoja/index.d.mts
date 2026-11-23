// Types for Hoja's core (index.mjs). Hand-written; `npm run types` checks them against the sources' use in tests.
export declare const HOJA_VERSION: string

export type HojaKind = 'heading' | 'paragraph' | 'bullet' | 'ordered' | 'task' | 'quote' | 'callout' | 'code' | 'mermaid' | 'toggle' | 'container' | 'admonition'
  | 'table' | 'rule' | 'embed' | 'html' | 'frontmatter'
export interface HojaBlock {
  index: number
  start: number
  end: number
  kind: HojaKind
  level?: number
  variant?: string
  lang?: string
  checksum: string
  /** 0.3 containers: how many `:::` containers hold the block, and the innermost opener's index. */
  depth?: number
  parent?: number | null
  /** On a fence block: open or close, the partner's index, and a toggle's title. */
  fence?: 'open' | 'close'
  close?: number
  open?: number
  title?: string
}
export interface HojaDoc { lines: string[], blocks: HojaBlock[], eol: '\n' | '\r\n' }
export interface HojaEdit { from: number, to: number, lines: string[] }
export interface HojaResult { text: string, edit: HojaEdit, focus: number | null }
export interface HojaSection { first: number, last: number, start: number, end: number }
export type HojaInput = string | HojaDoc

export declare function blockChecksum(lines: string[]): string
export declare function toLines(text?: string): string[]
export declare function eolOf(lines: string[]): '\n' | '\r\n'
export declare function parseBlocks(text?: string | string[]): HojaBlock[]
export declare function parseDoc(text?: string): HojaDoc
export declare function blockLines(doc: HojaDoc, index: number): string[]
export declare function blockText(doc: HojaDoc, index: number): string
export declare function blockAtLine(doc: HojaDoc, at: number): HojaBlock | null
export declare function headingText(line: string): string
export declare function slugify(text: string): string
export declare function sectionOf(doc: { blocks: HojaBlock[] }, index: number): HojaSection | null
export declare function outline(doc: HojaDoc): { index: number, level: number, text: string, slug: string }[]
export declare function blockAnchor(doc: HojaDoc, index: number): string
export declare function blockState(doc: HojaDoc, address: { index: number, checksum: string } | null): 'fresh' | 'stale' | 'orphaned'

export declare function diffEdit(a: string[], b: string[]): HojaEdit
export declare function applyEdit(lines: string[], edit: HojaEdit): string[]
export declare function replaceBlock(input: HojaInput, index: number, markdown: string): HojaResult
export declare function insertBlock(input: HojaInput, after: number, markdown: string): HojaResult
export declare function removeBlock(input: HojaInput, index: number, opts?: { section?: boolean }): HojaResult
export declare function duplicateBlock(input: HojaInput, index: number, opts?: { section?: boolean }): HojaResult
export declare function moveBlock(input: HojaInput, from: number, to: number, opts?: { section?: boolean }): HojaResult
export declare function nudgeBlock(input: HojaInput, index: number, direction: -1 | 1, opts?: { section?: boolean }): HojaResult
export declare function plainLines(lines: string[], kind: HojaKind): string[]
export declare const TURN_INTO: string[]
export declare function asKind(plain: string[], target: string, opts?: { variant?: string, lang?: string }): string[]
export declare function turnInto(input: HojaInput, index: number, target: string, opts?: { variant?: string, lang?: string }): HojaResult
export declare function toggleTask(input: HojaInput, index: number, line?: number): HojaResult

export interface HojaMenuItem { id: string, label: string, disabled?: boolean, danger?: boolean, ai?: boolean, hint?: string, children?: HojaMenuItem[], parent?: string }
export interface HojaMenuGroup { id: string, label?: string, items: HojaMenuItem[] }
export interface HojaSlashItem { id: string, icon: string, keywords: string, lines: string[], caret: [number, number] }
export declare const LABELS: Record<string, Record<string, string>>
export declare function label(key: string, lang?: string): string
export declare const SLASH_ITEMS: HojaSlashItem[]
export declare function filterSlash(query?: string, lang?: string, items?: HojaSlashItem[]): HojaSlashItem[]
export declare function kindId(block: HojaBlock | null | undefined): string
export declare function blockMenu(block: HojaBlock | null | undefined, opts?: { lang?: string, canEdit?: boolean, ai?: string[] | false, sectionAi?: boolean, collapsed?: boolean, first?: boolean, last?: boolean, extra?: HojaMenuItem[] }): HojaMenuGroup[]
export declare function menuItems(groups: HojaMenuGroup[]): HojaMenuItem[]
export declare function filterMenu(groups: HojaMenuGroup[], query?: string): HojaMenuItem[]

export type HojaAiAction = 'shorter' | 'expand' | 'translate' | 'rewrite' | 'section-shorter'
export declare const AI_ACTIONS: Record<HojaAiAction, { target: 'block' | 'section', instruction: string }>
export declare const AI_ACTION_IDS: HojaAiAction[]
export declare function languageName(lang: string): string
export declare function aiMessages(action: string, opts: { block: string, document?: string, path?: string, language?: string }): { role: 'system' | 'user', content: string }[]
export declare function parseAiAnswer(content: unknown, opts?: { heading?: string | null }): { lines: string[], summary: string } | null

export interface HojaActor { kind: 'human' | 'ai' | 'agent', name: string, model?: string }
export interface HojaVersion { id: string, at: string, actor: HojaActor, name?: string, message?: string }
export interface HojaStore {
  read(path: string): Promise<{ text: string, revision: string }>
  write(path: string, text: string, opts: { base: string, message?: string, actor?: HojaActor }): Promise<{ revision: string }>
  versions(path: string, opts?: { limit?: number }): Promise<HojaVersion[]>
  version(path: string, id: string): Promise<HojaVersion & { text: string }>
  blame(path: string, blocks: (string | { text: string })[]): Promise<({ actor: HojaActor, at: string, id: string } | null)[]>
  name?(path: string, id: string, name: string): Promise<void>
  draft?(path: string): Promise<{ branch: string }>
}
export interface HojaConnector { pull(pageId: string): Promise<string>, push(markdown: string, pageId: string): Promise<void>, link(path: string, pageId: string): Promise<void> }
export declare const STORE_METHODS: string[]
export declare const CONNECTOR_METHODS: string[]
export declare function missingMethods(store: unknown, methods?: string[]): string[]
export declare function memoryStore(initial?: Record<string, string>): HojaStore

export declare function markdownFilename(title?: string): string
export declare function markdownExport(text?: string, title?: string): string
export declare function downloadText(name: string, text: string, type?: string): void
export declare function printElement(el: HTMLElement, title?: string): void

export interface HojaAction { id: string, index: number, block: HojaBlock | null, section: boolean, to?: number, first?: number, last?: number }
export interface HojaChromeOptions {
  blocks: HojaBlock[] | (() => HojaBlock[])
  onAction?: (action: HojaAction) => void
  onFold?: (info: { index: number, collapsed: boolean }) => void
  onSelect?: (range: [number, number] | null) => void
  lang?: string
  canEdit?: boolean
  ai?: string[] | false
  /** false: no section-wide AI item on headings (a host whose AI targets one block only). */
  sectionAi?: boolean
  docKey?: string
  insert?: boolean
  menuExtra?: (block: HojaBlock | undefined, index: number) => HojaMenuItem[]
  /** Wraps every attribute write on host nodes (a ProseMirror host pauses its DOM observer here). */
  mutate?: (write: () => void) => void
  /** Called inside `mutate` before each refresh, so a host whose nodes get redrawn can re-tag `data-hoja-block`. */
  tag?: () => void
}
export interface HojaChrome {
  refresh(): void
  openMenu(index: number, x: number, y: number): void
  closeMenu(): void
  toggleFold(index: number): void
  /** 0.3: open (true), close (false) or flip a toggle. */
  toggleOpen(index: number, open?: boolean): void
  /** 0.3: select blocks a..f (null clears); the range as [first, last] or null. */
  select(a: number | null, f?: number): void
  selection(): [number, number] | null
  collapsed(): Set<string>
  setOptions(partial: Partial<HojaChromeOptions>): void
  destroy(): void
}
export declare function attachChrome(container: HTMLElement, options: HojaChromeOptions): HojaChrome
export interface HojaSlashMenu { update(query: string | null, rect: { left: number, bottom: number } | null): void, key(e: KeyboardEvent): boolean, readonly isOpen: boolean, close(): void, destroy(): void }
export declare function createSlashMenu(opts: { lang?: string, items?: HojaSlashItem[], onPick?: (item: HojaSlashItem) => void, onClose?: () => void }): HojaSlashMenu
export declare function attachSlash(textarea: HTMLTextAreaElement, opts?: { lang?: string, items?: HojaSlashItem[] }): { readonly isOpen: boolean, destroy(): void }
export declare function caretRect(textarea: HTMLTextAreaElement): { left: number, top: number, bottom: number }
export declare function slashQuery(lineText: string): string | null
export declare function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void
export declare function copyText(text: string): Promise<boolean>

// Proposals (proposal.mjs): a whole proposed document as hunks a person accepts or undoes.
export interface HojaHunkBlock { index: number, checksum: string, kind: HojaKind, level?: number, text: string }
export interface HojaWord { t: 'eq' | 'add' | 'del', w: string }
export interface HojaHunk {
  id: string
  kind: 'add' | 'del' | 'change'
  section: { title: string, slug: string }
  anchor: { index: number, checksum: string }
  afterAnchor: { index: number, checksum: string }
  beforeBlocks: HojaHunkBlock[]
  afterBlocks: HojaHunkBlock[]
  words?: HojaWord[]
  /** 0.3.1: neighbour checksums the hunk is located by ('^' top, '$' end) and the sibling hunks of its run. */
  context?: { prev: string[], next: string[], prevId?: string | null, nextId?: string | null }
  /** 0.3.1: checksums of the whole block list before and after; a body equal to one is located by index. */
  base?: [string, string]
  /** 0.3.1: `before`'s line ending, for writing into an empty body. */
  eol?: '\n' | '\r\n'
}
export interface HojaProposalCheck { ok: boolean, apply: boolean, revert: boolean }
export interface HojaHunkResult { text: string, applied: string[], stale: string[] }
export interface HojaHunkPlace { first: number | null, last: number | null, at: number }
export interface HojaProposalStats { changes: number, sections: number, removedSections: number, addedSections: number, addedWords: number, removedWords: number }
export declare function wordDiff(a?: string, b?: string): HojaWord[]
export declare function plainText(markdown?: string, kind?: string): string
export declare function proposalHunks(before?: string, after?: string): HojaHunk[]
export declare function applyHunks(body: string, hunks: HojaHunk[], ids?: string[] | null): HojaHunkResult
export declare function invertHunk(hunk: HojaHunk): HojaHunk
export declare function revertHunks(afterBody: string, hunks: HojaHunk[], ids?: string[] | null): HojaHunkResult
/** Post-condition: apply-all gives `after` and revert-all gives `before`, block for block; else write the whole text. */
export declare function checkProposal(before: string, after: string, hunks: HojaHunk[]): HojaProposalCheck
export declare function locateHunks(body: string, hunks: HojaHunk[]): Record<string, HojaHunkPlace | null>
export declare function proposalSections(hunks: HojaHunk[]): { slug: string, title: string, ids: string[] }[]
export declare function proposalStats(hunks: HojaHunk[]): HojaProposalStats

/** 0.3 containers (`::: indent`, `::: toggle <title>`, closed by `:::`). */
export declare function indentBlocks(input: HojaInput, first: number, last?: number): HojaResult
export declare function outdentBlocks(input: HojaInput, first: number, last?: number): HojaResult
export declare function toggleFrom(input: HojaInput, index: number, options?: { quote?: boolean, previous?: string | null }): HojaResult
export declare function wrapToggle(text: string, title: string): string
export declare function blockTarget(doc: HojaDoc, hash: string): number
