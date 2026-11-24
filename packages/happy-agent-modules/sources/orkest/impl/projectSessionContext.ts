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

/** The context set in a `focus` answer; null for a refusal, an older dashboard, or an answer without one. */
export function contextSetOf(answer: OrkestSessionAnswer | null | undefined): ContextFile[] | null {
    if (!answer?.ok) return null;
    const context = ((answer.body ?? {}) as { context?: unknown }).context;
    const files = (context ?? {}) as { files?: unknown };
    if (!Array.isArray(files.files)) return null;
    return files.files.flatMap((f): ContextFile[] => {
        const r = (f ?? {}) as Record<string, unknown>;
        return typeof r.path === "string" && typeof r.text === "string"
            ? [
                  {
                      path: r.path,
                      role: r.role === "main" ? "main" : "project",
                      truncated: r.truncated === true,
                      text: r.text,
                  },
              ]
            : [];
    });
}

/** The instructions' context section: the project files first, the main doc last. */
export function contextSection(files: readonly ContextFile[]): string {
    if (files.length === 0) return "";
    const ordered = [
        ...files.filter((f) => f.role === "project"),
        ...files.filter((f) => f.role === "main"),
    ];
    const parts = [
        `Project context, read when this session opened (the person sees this list in the Context chip): ${ordered.map((f) => f.path).join(", ")}. Read a file again with your tools before relying on it for a change; it may have moved since.`,
    ];
    for (const f of ordered) {
        const notes = [
            f.role === "main" ? "main doc" : "",
            f.truncated ? "cut, read the file for the rest" : "",
        ].filter(Boolean);
        parts.push(
            `<context-file path="${f.path}"${notes.length ? ` note="${notes.join("; ")}"` : ""}>\n${f.text}\n</context-file>`,
        );
    }
    return parts.join("\n\n");
}
