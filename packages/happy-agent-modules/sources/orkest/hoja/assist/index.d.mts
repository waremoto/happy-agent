// Hoja assist (0.5.0) declarations: `@waremoto/hoja/assist`.
import type { HojaHunk, HojaWord } from '../index.mjs'

// fence.mjs
export declare const MAX_ANSWER_TEXT: number
export declare const PROPOSAL_FENCES: string[]
export declare const DOCUMENT_FENCES: string[]
export interface HojaFencedBlock { name: string, attrs: string, body: string, before: string, closed: boolean }
export declare function fencedBlock(text: string | null | undefined, names: string[]): HojaFencedBlock | null
export declare function extractProposal(answer: string | null | undefined): { why: string, markdown: string, closed: boolean } | null
export declare function proposalDocument(markdown: string, options?: { title?: string, body?: string }): string
export declare function proposalFromAnswer(answer: string | null | undefined, title?: string, body?: string): string | null
export declare function documentFromAnswer(answer: string | null | undefined): { markdown: string, title: string, fenced: boolean }

// view.mjs
export type HojaAssistLang = 'en' | 'es'
export interface HojaProposalPlan {
  marks: Map<number, { hunk: HojaHunk, mark: 'new' | 'changed' }>
  previous: Map<number, HojaHunk[]>
  chips: Map<number, { slug: string, title: string, ids: string[] }>
}
export declare function proposalPlan(body: string, hunks: HojaHunk[]): HojaProposalPlan
export declare function proposalSummary(hunks: HojaHunk[], lang?: HojaAssistLang | boolean): string
export declare function goneLabel(hunk: HojaHunk, lang?: HojaAssistLang): string
export declare function removedWordsLabel(n: number, lang?: HojaAssistLang): string
export type HojaProposalRole = 'same' | 'new' | 'old' | 'gone'
export interface HojaProposalEntry {
  role: HojaProposalRole
  /** Lines [start, end) of the entry in the composite markdown (rendered nodes carry their first line). */
  start: number
  end: number
  hunk?: string
  /** A changed block's word diff: marks go on its words, not on the whole block. */
  words?: HojaWord[]
  /** `gone`: the quiet line a removal leaves. */
  label?: string
}
export interface HojaProposalView {
  markdown: string
  entries: HojaProposalEntry[]
  at: (line: number) => HojaProposalEntry | null
}
export declare function proposalView(after: string, hunks: HojaHunk[], showPrevious: boolean, options?: { lang?: HojaAssistLang }): HojaProposalView
export declare function proposalWordMarks(words: HojaWord[], side: 'new' | 'old'): { w: string, mark: boolean }[]

// contract.mjs
export declare const CONTRACT_LANGUAGES: string[]
export interface HojaContractOptions {
  host?: 'fence' | 'tool'
  lang?: HojaAssistLang
  longFence?: boolean
  documents?: boolean
  tool?: string
  workingCopy?: string
  modes?: boolean
  outline?: boolean
  language?: boolean
  intro?: string
  extra?: string
}
export declare function documentContract(options?: HojaContractOptions): string

// context.mjs
export interface HojaOutlineItem { heading: string, level: number, blocks: string, words: number }
export declare function documentOutline(body: string): HojaOutlineItem[]
export declare const MAX_CONTEXT: number
export declare const CONTEXT_ORDER: string[]
export declare const CONTEXT_BUDGETS: Record<string, number>
export declare const CACHE_ORDER: string[]
export declare function fitValue(value: unknown, budget: number): unknown
export declare function contextJson(context: Record<string, unknown>, max?: number, options?: { order?: string[], budgets?: Record<string, number>, cacheOrder?: string[], rest?: string }): string

// guards.mjs
export declare const MAX_AUTO_REMOVED_SHARE: number
export declare function removedShare(body: string, hunks: HojaHunk[]): number
export declare function isLargeRemoval(body: string, hunks: HojaHunk[], share?: number): boolean
export declare function baseChanged(baseRevision: unknown, currentRevision: unknown): boolean
export declare function holdReason(options?: { auto?: boolean, baseRevision?: unknown, currentRevision?: unknown, body?: string, hunks?: HojaHunk[], share?: number }): 'changed' | 'large' | null
export declare function writeKey(messageId: string, tool?: 'proposal' | 'replace'): string
export declare function alreadyWritten(keys: Iterable<string> | null | undefined, messageId: string, tool?: 'proposal' | 'replace'): boolean
export declare function createSeen(): Set<string>
export declare function shouldAutoPropose(seen: Set<string>, answer: { noteKey?: string, conversationId?: string, messageId?: string, isLatest?: boolean, aiMode?: string }): boolean
export interface HojaTurnBases {
  record(noteKey: string, conversationId: string | null | undefined, bodyRevision: number): void
  get(noteKey: string, conversationId: string | null | undefined): number | undefined
}
export declare function createTurnBases(): HojaTurnBases
export declare function reanchorBlock(anchor: { text?: string, prev?: string | null } | null | undefined, index: number, blocks: string[]): { index: number } | { insertAfter: number }

// actions.mjs
export interface HojaAssistAction {
  id: string
  proposes: boolean
  label: { en: string, es?: string }
  prompt: { en: string, es?: string }
}
export declare const ASSIST_ACTIONS: readonly HojaAssistAction[]
export declare function extendActions(base?: readonly HojaAssistAction[], extra?: (Omit<HojaAssistAction, 'proposes'> & { proposes?: boolean })[]): HojaAssistAction[]
export declare function findAction(catalogue: readonly HojaAssistAction[], id: string): HojaAssistAction | null
export declare function actionPrompt(catalogue: readonly HojaAssistAction[], id: string, options?: { lang?: HojaAssistLang, vars?: Record<string, string | number> }): string | null
export declare function actionLabel(action: HojaAssistAction | null | undefined, lang?: HojaAssistLang): string
