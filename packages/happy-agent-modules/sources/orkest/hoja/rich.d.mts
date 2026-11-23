// Hoja rich blocks (phase 4): ProseMirror JSON → markdown, and the faithful write-back of one edited block.
import type { HojaBlock, HojaDoc, HojaInput, HojaResult } from './index.mjs'

export interface HojaRichStyle { bullet: '-' | '*' | '+', delim: '.' | ')', strong: '**' | '__', em: '*' | '_', fence: '`' | '~', indent: number, tight: boolean }
/** ProseMirror JSON as `editor.getJSON()` returns it. */
export interface HojaPmNode { type: string, attrs?: Record<string, unknown>, content?: HojaPmNode[], text?: string, marks?: { type: string, attrs?: Record<string, unknown> }[] }
/** A block as it was opened for editing (index and checksum locate it again; lines are its source then). */
export interface HojaOpenedBlock { index: number, checksum: string, start?: number, end?: number, lines?: string[] }
export interface HojaRichConflict { conflict: true, lines: string[] }
export type HojaRichValue = { before: HojaPmNode, after: HojaPmNode, lines?: undefined } | { lines: string[], before?: undefined, after?: undefined }

export declare function richKind(block: HojaBlock | null | undefined): 'rich' | 'source'
export declare function blockStyle(markdown?: string): HojaRichStyle
export declare function richMarkdown(json: HojaPmNode | HojaPmNode[] | null | undefined, style?: Partial<HojaRichStyle>): string
export declare function faithfulLines(original: string[], roundTrip: string[], edited: string[]): string[]
export declare function relocateBlock(input: HojaInput, block: HojaOpenedBlock): number
export declare function richEdit(input: HojaInput | HojaDoc, opened: HojaOpenedBlock, value: HojaRichValue): HojaResult | HojaRichConflict | null
/** markdown-it: soft breaks as `<br data-hoja-soft>` (block editor only). */
export declare function markdownItSoftBreaks<T extends { renderer: { rules: Record<string, unknown> } }>(md: T): T
/** TipTap global attributes keeping the soft-break flag on `hardBreak`. */
export declare function richGlobalAttributes(): { types: string[], attributes: Record<string, { default: unknown, parseHTML: (el: HTMLElement) => unknown, renderHTML: (attrs: Record<string, unknown>) => Record<string, string> }> }[]
export declare function richInsert(input: HojaInput | HojaDoc, after: HojaOpenedBlock | null, value: { after?: HojaPmNode, lines?: string[] }): HojaResult | HojaRichConflict | null
