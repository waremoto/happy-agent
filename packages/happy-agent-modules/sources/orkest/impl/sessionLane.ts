/**
 * GHO-207.6.2 — the lane a Chat session runs on. A lane is a Happy provider (`claude`, `claude_gw`, `claude_api`,
 * `claude_cheap`, `codex`, `codex_gw`); the chat switches the conversation to one with `sessionModelUpdate`, and the
 * worker reports the provider and model the conversation ends up on, so each receipt says which lane answered.
 */

/** The lane and model a session's conversation runs on. */
export interface SessionLane {
    readonly lane: string;
    readonly modelId: string;
}

/** The event that records a session's lane after it opened. */
export const SESSION_LANE_EVENT = "attended.session_lane";

const LANE = /^[a-z][a-z0-9_]{0,31}$/;

function modeLane(value: unknown): SessionLane | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const { providerId, modelId } = value as { providerId?: unknown; modelId?: unknown };
    if (typeof providerId !== "string" || !LANE.test(providerId)) return undefined;
    if (typeof modelId !== "string" || modelId.length === 0) return undefined;
    return { lane: providerId, modelId };
}

/**
 * The lane an agent's conversation runs on, from its metadata: the mode of its last delivered message, else the mode
 * it was created with. Undefined when neither names a provider and a model.
 */
export function sessionLaneOf(metadata: Readonly<Record<string, unknown>> | undefined): SessionLane | undefined {
    if (metadata === undefined) return undefined;
    return modeLane(metadata["lastMode"]) ?? modeLane(metadata["initialMode"]);
}

/** The lane to report, or undefined when it is unknown or is the one already reported. */
export function sessionLaneChange(
    current: SessionLane | undefined,
    reported: SessionLane | undefined,
): SessionLane | undefined {
    if (current === undefined) return undefined;
    if (reported !== undefined && reported.lane === current.lane && reported.modelId === current.modelId)
        return undefined;
    return current;
}
