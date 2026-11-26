import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    CandidateAnswer,
    CandidateForVerify,
    ProposeCandidateInput,
    RecordCheckInput,
} from "./candidateTools.js";

export interface OrkestAgencyEndpoint {
    readonly url: string;
    readonly token: string;
    readonly workerId: string;
    /** This worker's own Orkest token; Father then scopes every owner call to its agency. */
    readonly workerToken?: string;
}

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** One attended run as Father's `/internal/agency/attended/*` feeds describe it (camelCase). */
export const attendedSessionSchema = Type.Object({
    runId: Type.String({ minLength: 1, maxLength: 64 }),
    state: Type.String(),
    harness: Type.String(),
    permissionMode: Type.Union([Type.Literal("read_only"), Type.Literal("workspace_write")]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    brief: Type.String({ maxLength: 20_000 }),
    workLabel: Type.String(),
    endRequestedAt: nullableString,
    intentId: nullableString,
    ownerJobRef: nullableString,
    fence: Type.Number(),
    /** Present only for a session opened from a handoff; read leniently by `readHandoffContinuation`. */
    continuation: Type.Optional(Type.Unknown()),
    /**
     * GHO-195/196 — on a project or doc session; GHO-204 adds `ticket` for a ticket session of a project, and
     * `repoPath`: where the project's repository is on the worker's host (null when it has none). Every field
     * after `kind` is additive, and an old row has no scope at all.
     */
    scope: Type.Optional(
        Type.Object({
            kind: Type.Union([
                Type.Literal("project"),
                Type.Literal("doc"),
                Type.Literal("ticket"),
            ]),
            projectId: Type.String({ minLength: 1, maxLength: 80 }),
            path: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
            repoPath: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
        }),
    ),
    /** GHO-204 — the project every session belongs to; absent on an old ticket row. */
    projectId: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
    /** GHO-204 — the project's title when Father names it, for the task's display name; Father does not send it yet. */
    projectTitle: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    /** GHO-195 — `happy` or `librechat`; present only on a project or doc session. */
    backend: Type.Optional(Type.String()),
    startedBy: Type.Optional(Type.Unknown()),
    /** GHO-209 — present only on a session a person opened to check one proposed change. */
    verify: Type.Optional(
        Type.Union([
            Type.Object({ candidateId: Type.String({ minLength: 1, maxLength: 64 }) }),
            Type.Null(),
        ]),
    ),
});
export type AttendedSession = Static<typeof attendedSessionSchema>;

const leaseSchema = Type.Object({ status: Type.String(), fenceToken: Type.Number() });

/** One human reply or rejection waiting in Father's owner outbox. */
const candidateOutboxMessageSchema = Type.Object({
    messageId: Type.String({ minLength: 1, maxLength: 64 }),
    candidateId: Type.String({ minLength: 1, maxLength: 64 }),
    kind: Type.Union([Type.Literal("reply"), Type.Literal("reject")]),
    body: Type.String({ minLength: 1, maxLength: 4_000 }),
    author: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    workItem: Type.String({ minLength: 1, maxLength: 300 }),
    title: Type.String({ minLength: 1, maxLength: 300 }),
});
export type CandidateOutboxMessage = Static<typeof candidateOutboxMessageSchema>;

/** An owner call's answer: `final` means the run is no longer this owner's (revoked, stale, gone). */
export interface AgencyAnswer {
    readonly ok: boolean;
    readonly final: boolean;
}

/**
 * The owner side of Father's agency API, authenticated with the Father service token. Every
 * response is validated; anything unexpected is an error, so the loop retries rather than acting.
 */
export class OrkestAgencyClient {
    readonly #endpoint: OrkestAgencyEndpoint;

    constructor(endpoint: OrkestAgencyEndpoint) {
        this.#endpoint = endpoint;
    }

    async pending(): Promise<AttendedSession[]> {
        return this.#sessions(await this.#call("GET", "/internal/agency/attended/pending"));
    }

    async active(workerId: string): Promise<AttendedSession[]> {
        return this.#sessions(
            await this.#call(
                "GET",
                `/internal/agency/attended/active?worker=${encodeURIComponent(workerId)}`,
            ),
        );
    }

    async acknowledge(intentId: string, ownerJobRef: string): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/intents/${intentId}/ack`, { ownerJobRef }),
        );
    }

    /** The new fence, or `undefined` when the run cannot be claimed (revoked, ended, not a member). */
    async claim(
        runId: string,
        workerId: string,
        leaseSeconds: number,
    ): Promise<{ fence: number } | undefined> {
        const response = await this.#call("POST", `/internal/agency/runs/${runId}/claim`, {
            workerId,
            leaseSeconds,
        });
        if (response.status === 409) return undefined;
        if (response.status !== 200 || !Value.Check(leaseSchema, response.body)) {
            throw new Error(`Orkest claim answered ${response.status}.`);
        }
        return { fence: response.body.fenceToken };
    }

    async heartbeat(runId: string, fence: number, leaseSeconds: number): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/runs/${runId}/heartbeat`, {
                fence,
                leaseSeconds,
            }),
        );
    }

    /** Read the owner queue; Father authenticates the holder, with no fence query. */
    async candidateMessages(runId: string): Promise<CandidateOutboxMessage[]> {
        const response = await this.#call(
            "GET",
            `/internal/agency/runs/${encodeURIComponent(runId)}/candidate-messages`,
        );
        const schema = Type.Array(candidateOutboxMessageSchema);
        if (response.status !== 200 || !Value.Check(schema, response.body)) {
            throw new Error("Candidate messages unavailable.");
        }
        return response.body;
    }

    /** Mark a queued human message delivered after Happy durably accepts it. */
    async candidateMessageDelivered(
        runId: string,
        messageId: string,
        fence: number,
    ): Promise<AgencyAnswer> {
        return answer(
            await this.#call(
                "POST",
                `/internal/agency/runs/${encodeURIComponent(runId)}/candidate-messages/${encodeURIComponent(messageId)}/delivered`,
                { fence },
            ),
        );
    }

    async publish(
        runId: string,
        fence: number,
        eventType: string,
        payload: Record<string, unknown>,
    ): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/runs/${runId}/publish`, {
                fence,
                eventType,
                agentId: this.#endpoint.workerId,
                toolId: null,
                payload,
            }),
        );
    }

    /**
     * Tell Orkest which native agent session (the Claude session id) this run's conversation is in, so
     * the cockpit can show its transcript. Display-only on both sides: `false` for any refusal, never a
     * throw, so a failed link can never disturb the run itself.
     */
    async linkAgentSession(runId: string, fence: number, agentSessionId: string): Promise<boolean> {
        try {
            const response = await this.#call(
                "POST",
                `/internal/agency/attended/${runId}/agent-session`,
                { fence, agentSessionId },
            );
            return response.status === 200;
        } catch {
            return false;
        }
    }

    /** Proposed, with one session consumed: the person ended it and the budget counts sessions. */
    async complete(runId: string, fence: number, reason: string): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/runs/${runId}/complete`, {
                fence,
                proposed: true,
                consumed: 1,
                reason,
            }),
        );
    }

    /** GHO-209 — publish a proposed change (a diff plus its ask) for this run's ticket. */
    async proposeCandidate(
        runId: string,
        fence: number,
        input: ProposeCandidateInput,
    ): Promise<CandidateAnswer> {
        const r = await this.#call(
            "POST",
            `/internal/agency/runs/${encodeURIComponent(runId)}/candidates`,
            { fence, ...input },
        );
        if (r.status === 201)
            return { ok: true, id: String((r.body as { artifactId?: unknown })?.artifactId ?? "") };
        return { ok: false, reason: refusal(r) };
    }

    /** GHO-209 — the exact change a verify run was opened to check; null for any other run. */
    async readCandidate(runId: string): Promise<CandidateForVerify | null> {
        const r = await this.#call(
            "GET",
            `/internal/agency/runs/${encodeURIComponent(runId)}/candidate`,
        );
        if (r.status !== 200 || typeof r.body !== "object" || r.body === null) return null;
        const c = r.body as CandidateForVerify;
        return typeof c.candidateId === "string" &&
            typeof c.sha256 === "string" &&
            typeof c.patchBase64 === "string"
            ? c
            : null;
    }

    /** GHO-209 — a verify run's receipt; its only subject is the candidate Father gave the run. */
    async recordReceipt(
        runId: string,
        fence: number,
        input: RecordCheckInput,
    ): Promise<CandidateAnswer> {
        const r = await this.#call(
            "POST",
            `/internal/agency/runs/${encodeURIComponent(runId)}/receipts`,
            {
                fence,
                verifierId: input.verifierId,
                ...(input.verifierName ? { verifierName: input.verifierName } : {}),
                subjects: [{ artifactId: input.candidateId, sha256: input.sha256 }],
                checkSet: input.checkSet,
                verdict: input.verdict,
                reason: input.reason,
            },
        );
        if (r.status === 201)
            return { ok: true, id: String((r.body as { receiptId?: unknown })?.receiptId ?? "") };
        return { ok: false, reason: refusal(r) };
    }

    #sessions(response: { status: number; body: unknown }): AttendedSession[] {
        if (response.status !== 200 || !Array.isArray(response.body)) {
            throw new Error(`Orkest answered ${response.status}.`);
        }
        return response.body.filter((item): item is AttendedSession =>
            Value.Check(attendedSessionSchema, item),
        );
    }

    async replyInvites(runId: string, fence: number) {
        const result = await this.#call(
            "GET",
            `/internal/agency/dossiers/bot/invites?runId=${runId}&fence=${fence}`,
        );
        const schema = Type.Array(
            Type.Object({
                dossierId: Type.String(),
                nodeId: Type.String(),
                commentId: Type.String(),
            }),
        );
        if (result.status !== 200 || !Value.Check(schema, result.body))
            throw new Error("Dossier requests unavailable.");
        return result.body;
    }

    async annotationAccess(runId: string, fence: number) {
        const result = await this.#call(
            "GET",
            `/internal/agency/dossiers/bot/capabilities?runId=${runId}&fence=${fence}`,
        );
        const schema = Type.Array(
            Type.Object({ dossierId: Type.String(), grantId: Type.String(), tool: Type.String() }),
        );
        if (result.status !== 200 || !Value.Check(schema, result.body))
            throw new Error("Dossier access unavailable.");
        return result.body;
    }

    async annotationContext(runId: string, fence: number) {
        const grants = await this.annotationAccess(runId, fence);
        return Promise.all(
            grants
                .filter((g) => g.tool === "dossier.annotation_context")
                .map(async (g) => {
                    const result = await this.#call(
                        "GET",
                        `/internal/agency/dossiers/${g.dossierId}/bot/context?runId=${runId}&fence=${fence}&grantId=${g.grantId}`,
                    );
                    if (result.status !== 200) throw new Error("Dossier context unavailable.");
                    return { dossierId: g.dossierId, context: result.body };
                }),
        );
    }

    async answerAnnotation(
        runId: string,
        fence: number,
        input: {
            dossierId: string;
            nodeId: string;
            commentId: string;
            text: string;
            commandId: string;
        },
    ) {
        const grant = (await this.annotationAccess(runId, fence)).find(
            (g) => g.tool === "dossier.answer_annotation" && g.dossierId === input.dossierId,
        );
        if (!grant) throw new Error("This run cannot answer in this dossier.");
        const result = await this.#call(
            "POST",
            `/internal/agency/dossiers/${grant.dossierId}/bot/reply?runId=${runId}&fence=${fence}&grantId=${grant.grantId}`,
            input,
        );
        if (result.status !== 200) throw new Error(`Reply refused (${result.status}).`);
        return "Reply saved on the original annotation.";
    }

    async #call(
        method: "GET" | "POST",
        path: string,
        body?: unknown,
    ): Promise<{ status: number; body: unknown }> {
        const response = await fetch(`${this.#endpoint.url}${path}`, {
            method,
            headers: {
                "X-Ghost-Service-Token": this.#endpoint.token,
                ...(this.#endpoint.workerToken === undefined
                    ? {}
                    : { "X-Orkest-Worker-Token": this.#endpoint.workerToken }),
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 500) throw new Error(`Orkest answered ${response.status}.`);
        const text = await response.text();
        let parsed: unknown = null;
        try {
            parsed = text.length === 0 ? null : JSON.parse(text);
        } catch {
            parsed = null;
        }
        return { status: response.status, body: parsed };
    }
}

function refusal(r: { status: number; body: unknown }): string {
    const b = r.body as { reason?: unknown; error?: unknown } | null;
    const why =
        typeof b?.reason === "string" ? b.reason : typeof b?.error === "string" ? b.error : null;
    return why ? `${why} (${r.status})` : `answered ${r.status}`;
}

function answer(response: { status: number; body: unknown }): AgencyAnswer {
    if (response.status === 200) return { ok: true, final: false };
    // 404 gone, 409 revoked/stale/conflict: the run is no longer this owner's.
    if (response.status === 404 || response.status === 409) return { ok: false, final: true };
    throw new Error(`Orkest answered ${response.status}.`);
}
