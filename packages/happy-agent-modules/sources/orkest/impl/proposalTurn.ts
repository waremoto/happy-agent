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

/** GHO-205.7.1 stub: still a random id. */
export function proposalTurn(
    store: ProposalTurnStore,
    ctx: Context,
    _callId?: string,
): Promise<string> {
    return store.getOrCreate(
        ctx,
        "orkest.turn",
        () => `t-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    );
}
