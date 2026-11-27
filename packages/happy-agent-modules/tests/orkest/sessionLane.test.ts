// GHO-207.6.2 — the worker reports the lane a session's conversation ends up on: the provider and model of its last
// delivered message, else the mode it opened with, and only when that changed since the last report.
import { describe, expect, it } from "vitest";

import { sessionLaneChange, sessionLaneOf } from "../../sources/orkest/impl/sessionLane.js";

describe("session lane", () => {
    it("reads the last delivered mode first, then the opening mode", () => {
        expect(
            sessionLaneOf({
                initialMode: { providerId: "claude", modelId: "claude-code/sonnet" },
                lastMode: { providerId: "claude_gw", modelId: "claude-sonnet-5-5" },
            }),
        ).toEqual({ lane: "claude_gw", modelId: "claude-sonnet-5-5" });
        expect(sessionLaneOf({ initialMode: { providerId: "codex", modelId: "codex-cli/gpt-6.1-sol" } })).toEqual({
            lane: "codex",
            modelId: "codex-cli/gpt-6.1-sol",
        });
    });

    it("names no lane for a missing or malformed mode", () => {
        expect(sessionLaneOf(undefined)).toBeUndefined();
        expect(sessionLaneOf({})).toBeUndefined();
        expect(sessionLaneOf({ lastMode: null, initialMode: null })).toBeUndefined();
        expect(sessionLaneOf({ lastMode: { providerId: "Claude GW", modelId: "x" } })).toBeUndefined();
        expect(sessionLaneOf({ lastMode: { providerId: "claude_api", modelId: "" } })).toBeUndefined();
    });

    it("reports a lane once, and again only when the lane or its model changes", () => {
        const gw = { lane: "claude_gw", modelId: "claude-sonnet-5-5" };
        expect(sessionLaneChange(gw, undefined)).toEqual(gw);
        expect(sessionLaneChange(gw, gw)).toBeUndefined();
        expect(sessionLaneChange({ ...gw, modelId: "claude-haiku-5-5" }, gw)).toEqual({
            lane: "claude_gw",
            modelId: "claude-haiku-5-5",
        });
        expect(sessionLaneChange(undefined, gw)).toBeUndefined();
    });
});
