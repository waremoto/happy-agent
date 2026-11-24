/**
 * GHO-205.3.2 (Orkest docs/design/orkest-doc-and-chat.md D-46, D-48) — the session keeps its main doc in mind.
 *
 * Before every turn of a project or doc session the Orkest module asks the dashboard's `focus` session tool for the
 * main doc (a doc session's doc, the person's "Change the main doc" choice, else ROADMAP, README, CONTEXT), with the
 * revision the agent last saw. When the doc moved, or the person chose another one, the agent gets one hidden system
 * steer: what changed, by whom and when (per commit, when the dashboard has the doc's log), and the doc's text now.
 * The revision seen is kept in the agent's store, so a restart does not repeat the notice.
 */
import type { OrkestSessionAnswer, OrkestSessionCall } from "./OrkestSessionClient.js";

export interface MainDocSeen {
    readonly path: string;
    readonly rev: string;
}

export interface MainDocCommit {
    readonly sha: string;
    readonly subject: string;
    readonly author: string;
    readonly at: string;
    readonly actor: string | null;
}

export interface MainDocFocus {
    readonly path: string;
    readonly rev: string;
    readonly text: string;
    readonly changed: boolean;
    readonly changes: readonly MainDocCommit[] | null;
    readonly readOnly: boolean;
}

export const MAIN_DOC_SEEN_KEY = "orkest.mainDoc.seen";
/** The steer carries at most this much of the doc; the agent reads the rest with read_doc. */
const MAX_TEXT = 24_000;

/** The `focus` answer, checked; null for a refusal, an older dashboard (no such tool) or a project with no main doc. */
export function mainDocFocusOf(answer: OrkestSessionAnswer): MainDocFocus | null {
    if (!answer.ok) return null;
    const b = (answer.body ?? {}) as Record<string, unknown>;
    if (typeof b.path !== "string" || typeof b.rev !== "string" || typeof b.text !== "string")
        return null;
    const changes = Array.isArray(b.changes)
        ? (b.changes as unknown[]).flatMap((c) => {
              const r = (c ?? {}) as Record<string, unknown>;
              return typeof r.sha === "string" && typeof r.subject === "string"
                  ? [
                        {
                            sha: r.sha,
                            subject: r.subject,
                            author: typeof r.author === "string" ? r.author : "",
                            at: typeof r.at === "string" ? r.at : "",
                            actor: typeof r.actor === "string" ? r.actor : null,
                        },
                    ]
                  : [];
          })
        : null;
    return {
        path: b.path,
        rev: b.rev,
        text: b.text,
        changed: b.changed === true,
        changes,
        readOnly: b.readOnly === true,
    };
}

const who = (c: MainDocCommit) =>
    [c.author || "someone", c.actor ? `(${c.actor})` : ""].filter(Boolean).join(" ");

/** The steer's text: what moved, then the doc now. */
export function mainDocChangeNote(seen: MainDocSeen, focus: MainDocFocus): string {
    const lines: string[] = [];
    if (seen.path !== focus.path) {
        lines.push(
            `The main doc of this session is now \`${focus.path}\` (it was \`${seen.path}\`). Keep it in mind from this turn on.`,
        );
    } else if (focus.changes && focus.changes.length > 0) {
        lines.push(`The main doc changed: \`${focus.path}\`, since you last read it:`);
        for (const c of focus.changes.slice(0, 10))
            lines.push(`- ${c.subject} by ${who(c)} at ${c.at} (${c.sha.slice(0, 7)})`);
        if (focus.changes.length > 10) lines.push(`- and ${focus.changes.length - 10} more`);
    } else {
        lines.push(
            `The main doc changed: \`${focus.path}\` has a new revision since you last read it.`,
        );
    }
    if (focus.readOnly)
        lines.push("The person can only read this project: proposals wait for an editor.");
    const text = focus.text.length > MAX_TEXT ? `${focus.text.slice(0, MAX_TEXT)}\n…` : focus.text;
    lines.push("", `Its text now (revision ${focus.rev.slice(0, 12)}):`, "", text);
    return lines.join("\n");
}

export interface MainDocTurnDeps {
    readonly tool: (
        name: "focus",
        call: OrkestSessionCall,
        args: Record<string, unknown>,
    ) => Promise<OrkestSessionAnswer>;
    readonly call: OrkestSessionCall;
    /** What the agent saw last: the stored value, else the doc the session opened on. */
    readonly read: () => Promise<MainDocSeen | undefined>;
    readonly write: (seen: MainDocSeen) => Promise<void>;
}

/**
 * One turn's check. Returns the note to steer, or null when nothing moved (or the seam cannot say). A seam failure
 * never blocks the turn.
 */
export async function mainDocTurn(deps: MainDocTurnDeps): Promise<string | null> {
    const seen = await deps.read();
    let answer: OrkestSessionAnswer;
    try {
        answer = await deps.tool("focus", deps.call, seen ? { since: seen.rev } : {});
    } catch {
        return null;
    }
    const focus = mainDocFocusOf(answer);
    if (!focus) return null;
    await deps.write({ path: focus.path, rev: focus.rev });
    if (!seen || (seen.path === focus.path && seen.rev === focus.rev)) return null;
    return mainDocChangeNote(seen, focus);
}

/** The doc a session opens on: the `focus` answer's, else the first of ROADMAP, README, CONTEXT the project has. */
export function mainDocOpenPath(
    answer: OrkestSessionAnswer | null,
    paths: readonly string[],
): string | undefined {
    const focus = answer ? mainDocFocusOf(answer) : null;
    if (focus && paths.includes(focus.path)) return focus.path;
    for (const p of ["docs/ROADMAP.md", "docs/README.md", "docs/CONTEXT.md"])
        if (paths.includes(p)) return p;
    return undefined;
}
