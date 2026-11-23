import type { OrkestSessionCall, OrkestSessionClient } from "./OrkestSessionClient.js";

/** GHO-199.4.1 red: note delivery, not built yet. */
export interface ProjectSessionNote {
    readonly runId: string;
    readonly state: string;
}

export interface NoteDelivery {
    readonly send: (text: string, id: string, from: "orkest" | "person") => Promise<boolean>;
}

export function noteLine(_note: ProjectSessionNote): string {
    return "";
}

export async function deliverProjectSessionNotes(
    _client: OrkestSessionClient,
    _call: OrkestSessionCall,
    _delivery: NoteDelivery,
): Promise<{ notes: number; prompts: number }> {
    return { notes: 0, prompts: 0 };
}
