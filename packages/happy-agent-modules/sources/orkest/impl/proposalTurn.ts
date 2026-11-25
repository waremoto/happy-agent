import { randomUUID } from "node:crypto";

import type { Context } from "@steve.kite/stdlib";

/** The run store the turn is kept in: one turn per agent run (`scope.runKV`). */
export interface ProposalTurnStore {
    getOrCreate<Value>(
        ctx: Context,
        key: string,
        create: () => Value | Promise<Value>,
    ): Promise<Value>;
}

/** The dashboard's and the renderer's turn check (`Orkest-Turn` trailer, `orkest-chat:scroll-to`). */
const TURN_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * GHO-205.7.1 (Orkest design D-52) — the turn a proposal carries into its commit's `Orkest-Turn` trailer. It is the
 * first proposing tool call's Base id, the id the conversation shows that call under, so GhostShell's "Show previous"
 * can ask the chat to scroll there. One turn per run, as before; a call id that fails the turn check falls back to
 * the old random id.
 */
export function proposalTurn(
    store: ProposalTurnStore,
    ctx: Context,
    callId?: string,
): Promise<string> {
    return store.getOrCreate(ctx, "orkest.turn", () =>
        callId !== undefined && TURN_ID.test(callId)
            ? callId
            : `t-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
}
