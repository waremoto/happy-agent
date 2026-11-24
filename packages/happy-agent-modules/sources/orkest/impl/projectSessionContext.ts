/**
 * GHO-205.6.1 (Orkest docs/design/orkest-doc-and-chat.md § 8, D-42) — the context set every session gets.
 *
 * At open the Orkest module asks the dashboard's `focus` session tool for the context set too (`context: true`): the
 * project's `.orkest/context.json` files, else AGENTS.md or CLAUDE.md, README, CONTEXT and ROADMAP (whichever exist),
 * plus the main doc, each cut past the dashboard's budget. The set goes into the session's instructions, stable files
 * first so the prompt cache holds, and the person sees the same list in the Context chip.
 */
import type { OrkestSessionAnswer } from "./OrkestSessionClient.js";

export interface ContextFile {
    readonly path: string;
    readonly role: "project" | "main";
    readonly truncated: boolean;
    readonly text: string;
}

/** Red stub (GHO-205.6.1): no context set yet. */
export function contextSetOf(
    _answer: OrkestSessionAnswer | null | undefined,
): ContextFile[] | null {
    return null;
}

/** Red stub (GHO-205.6.1). */
export function contextSection(_files: readonly ContextFile[]): string {
    return "";
}
