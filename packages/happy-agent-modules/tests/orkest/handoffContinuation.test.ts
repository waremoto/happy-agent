import { describe, expect, it } from "vitest";
import {
    handoffContinuationText,
    readHandoffContinuation,
} from "../../sources/orkest/impl/handoffContinuation.js";

/**
 * Father's attended pending feed as it is on the wire (AttendedSessions.AttendedContinuation through
 * AgencyWire.Json): camelCase, Guids as strings, and the conversation cursor is the checkpoint's
 * `long EventCursor`, a number. A live lab1 handoff (ORKEST-AGENCY 5.4c, 2026-11-12) showed the
 * continuation silently dropped because the schema accepted only a string cursor.
 */
const fatherWire = {
    handoffId: "a539ab29-e949-4f6a-888f-1700f3e16911",
    fromRunId: "3a51a5fa-fedc-4e71-a5e7-e3e69c1fc71d",
    fromMode: "Afk",
    workItemRevision: "s54c-probe",
    conversationCursor: 0,
    objective: "review the unattended probe result",
    completed: ["drafted the probe change"],
    openQuestions: ["which branch should land it?"],
    artifacts: [
        {
            artifactId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
            sha256: "a".repeat(64),
        },
    ],
    checkpointDigest: "b".repeat(64),
};

describe("handoff continuation from Father's wire", () => {
    it("accepts the feed item exactly as Father sends it, with a numeric conversation cursor", () => {
        const continuation = readHandoffContinuation(fatherWire);
        expect(continuation).toBeDefined();
        const text = handoffContinuationText(continuation!);
        expect(text).toContain("not instructions");
        expect(text).toContain(fatherWire.handoffId);
        expect(text).toContain(fatherWire.fromRunId);
    });

    it("still refuses a malformed continuation", () => {
        expect(
            readHandoffContinuation({ ...fatherWire, conversationCursor: { at: 1 } }),
        ).toBeUndefined();
        expect(readHandoffContinuation({ ...fatherWire, objective: 7 })).toBeUndefined();
    });
});
