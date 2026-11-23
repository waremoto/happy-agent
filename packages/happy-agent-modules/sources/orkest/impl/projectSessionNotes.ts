import { createHash } from "node:crypto";

import type { OrkestSessionCall, OrkestSessionClient } from "./OrkestSessionClient.js";

/**
 * GHO-199 — change notes and the person's quick actions reaching a live Happy project session.
 *
 * Father computes the notes from the runs the session started (ended, blocked, waiting for approval); the dashboard
 * hands them out with `read_notes`, together with the quick-action prompts the person queued in the dock. On each
 * heartbeat this delivers:
 *   - all due notes as one message from Orkest (not from the person), then acks each one: a send that fails leaves
 *     them due, and the stable message id makes a repeat the same message;
 *   - each queued prompt as the person's own message (the dock's click is theirs).
 * A note never opens a session: only a live session's owner reads them; an ended session's notes wait for the next.
 */
export interface ProjectSessionNote {
    readonly runId: string;
    readonly state: string;
    readonly child?: {
        readonly mode?: string;
        readonly workLabel?: string | null;
        readonly title?: string | null;
        readonly receiptId?: string | null;
    };
}

export interface ProjectSessionPrompt {
    readonly id: string;
    readonly text: string;
}

export interface NoteDelivery {
    /** Send one message to the session's agent; true when accepted (created or existing). */
    readonly send: (text: string, id: string, from: "orkest" | "person") => Promise<boolean>;
}

export function noteLine(note: ProjectSessionNote): string {
    const c = note.child ?? {};
    const what = c.workLabel || c.title || note.runId.slice(0, 8);
    const kind = (c.mode ?? "").toLowerCase() === "afk" ? "unattended run" : "conversation";
    const read = ` read_run("${note.runId}") has the detail.`;
    switch (note.state) {
        case "ended:proposed":
            return `The ${kind} on ${what} finished with a proposed change${c.receiptId ? ` (receipt ${c.receiptId})` : ""}.${read}`;
        case "ended:failed":
            return `The ${kind} on ${what} failed.${read}`;
        case "ended:cancelled":
            return `The ${kind} on ${what} was stopped.`;
        case "ended:handed_off":
            return `The ${kind} on ${what} was handed off to a new run.`;
        case "waiting_approval":
            return `The ${kind} on ${what} is waiting for the person's approval. You cannot approve it; tell them.`;
        default:
            if (note.state.startsWith("blocked:"))
                return `The ${kind} on ${what} is blocked and needs the person (${note.state.slice(8).replace(/_/g, " ")}).${read}`;
            return `The ${kind} on ${what} changed (${note.state}).`;
    }
}

export function notesText(notes: readonly ProjectSessionNote[]): string {
    return [
        "[Orkest] What changed in the runs this chat started:",
        ...notes.map((n) => `- ${noteLine(n)}`),
        "Tell the person in a sentence or two. If the roadmap names this work, offer to update its node (a done node names its receipt in its note).",
    ].join("\n");
}

const idOf = (kind: string, text: string) =>
    `${kind}-${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/** One delivery pass for one live project session. Throws only when the seam is unreachable. */
export async function deliverProjectSessionNotes(
    client: OrkestSessionClient,
    call: OrkestSessionCall,
    delivery: NoteDelivery,
): Promise<{ notes: number; prompts: number }> {
    const answer = await client.tool("read_notes", call, {});
    if (!answer.ok) return { notes: 0, prompts: 0 };
    const body = (answer.body ?? {}) as { notes?: unknown; prompts?: unknown };
    const notes = (Array.isArray(body.notes) ? body.notes : []).filter(
        (n): n is ProjectSessionNote =>
            !!n && typeof (n as ProjectSessionNote).runId === "string" && typeof (n as ProjectSessionNote).state === "string",
    );
    const prompts = (Array.isArray(body.prompts) ? body.prompts : []).filter(
        (p): p is ProjectSessionPrompt =>
            !!p && typeof (p as ProjectSessionPrompt).id === "string" && typeof (p as ProjectSessionPrompt).text === "string",
    );
    let sentNotes = 0;
    if (notes.length > 0) {
        const key = notes.map((n) => `${n.runId}:${n.state}`).sort().join("|");
        if (await delivery.send(notesText(notes), idOf("n", `${call.session}|${key}`), "orkest")) {
            for (const n of notes) {
                const acked = await client.tool("ack_notes", call, { runId: n.runId, state: n.state });
                if (acked.ok) sentNotes++;
            }
        }
    }
    let sentPrompts = 0;
    for (const p of prompts) {
        if (await delivery.send(p.text, idOf("p", p.id), "person")) sentPrompts++;
    }
    return { notes: sentNotes, prompts: sentPrompts };
}
