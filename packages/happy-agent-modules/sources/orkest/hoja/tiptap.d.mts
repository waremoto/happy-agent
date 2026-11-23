// Hoja's TipTap adapter (phase 4). TipTap is the host's: pass its Editor class, extensions and markdown renderer.
import type { HojaDoc, HojaResult } from './index.mjs'
import type { HojaOpenedBlock, HojaRichConflict } from './rich.mjs'

export type HojaBlockCloseReason = 'blur' | 'escape' | 'up' | 'down' | 'commit'
export interface HojaBlockEditorOptions {
  element: HTMLElement
  doc: string | HojaDoc
  index: number
  at?: { left: number, top: number } | null
  caret?: 'start' | 'end'
  /** A new empty block below block `index` (-1: the top); closing inserts what was typed. */
  insert?: boolean
  /** The document's text now; the write-back is computed against it. */
  current?: () => string | HojaDoc
  onClose?: (result: HojaResult | HojaRichConflict | null, reason: HojaBlockCloseReason) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor?: new (options: any) => any
  extensions?: unknown[]
  toHtml?: (markdown: string) => string
  editorProps?: Record<string, any>
  classes?: string
}
export interface HojaBlockEditor {
  kind: 'rich' | 'source'
  block: HojaOpenedBlock | null
  insert: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor?: any
  textarea?: HTMLTextAreaElement
  close(reason?: HojaBlockCloseReason): void
  destroy(): void
}
export declare function openBlockEditor(options: HojaBlockEditorOptions): HojaBlockEditor | null
