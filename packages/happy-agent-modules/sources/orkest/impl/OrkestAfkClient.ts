import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { AgencyAnswer } from "./OrkestAgencyClient.js";

/**
 * Where the unattended (AFK) lane of Father's agency API lives and who this worker is. Both
 * tokens travel on every call: the Father service token, and this worker's own Orkest token,
 * without which the AFK lane refuses the call.
 */
export interface OrkestAfkEndpoint {
    readonly url: string;
    readonly token: string;
    readonly workerToken: string;
    readonly workerId: string;
    /** `ORKEST_AFK_MODEL` as written: `<providerId>:<modelId>`, or a model id the catalog knows. */
    readonly model: string;
    /** Optional root for per-run work directories. */
    readonly workRoot?: string;
    /** Optional repository; each run then works in its own `git worktree` of it. */
    readonly repo?: string;
}

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** One unattended run as Father's `/internal/agency/afk/*` feeds describe it (camelCase). */
export const afkRunSchema = Type.Object({
    runId: Type.String({ minLength: 1, maxLength: 64 }),
    state: Type.String(),
    title: Type.String({ minLength: 1, maxLength: 300 }),
    brief: Type.String({ maxLength: 20_000 }),
    workLabel: Type.String(),
    stopRequestedAt: nullableString,
    intentId: nullableString,
    ownerJobRef: nullableString,
    fence: Type.Number(),
});
export type AfkRun = Static<typeof afkRunSchema>;

const leaseSchema = Type.Object({ status: Type.String(), fenceToken: Type.Number() });

export const afkApprovalSchema = Type.Object({
    key: Type.String(),
    tool: Type.String(),
    state: Type.Union([
        Type.Literal("pending"),
        Type.Literal("approved"),
        Type.Literal("denied"),
        Type.Literal("cancelled"),
    ]),
    answeredBy: Type.Optional(nullableString),
});
export type AfkApproval = Static<typeof afkApprovalSchema>;

/** What a worker asks a person about one gated call. */
export interface AfkApprovalRequest {
    readonly key: string;
    readonly tool: string;
    readonly summary: string;
    readonly reason: string;
    readonly inputSha256: string;
    readonly inputPreview: string;
}

/** How a run ends, in the shape Father's complete endpoint takes. */
export type AfkCompletion =
    | { readonly kind: "proposed" }
    | { readonly kind: "declined"; readonly reason: "approval_denied" | "stopped_by_person" }
    | { readonly kind: "failed"; readonly reason: string };

/**
 * The owner side of Father's AFK lane. Every response is validated; anything unexpected is an
 * error, so the owner loop retries rather than acting on it. Nothing here logs a token or a body.
 */
export class OrkestAfkClient {
    readonly #endpoint: OrkestAfkEndpoint;

    constructor(endpoint: OrkestAfkEndpoint) {
        this.#endpoint = endpoint;
    }

    async pending(): Promise<AfkRun[]> {
        return runs(await this.#call("GET", "/internal/agency/afk/pending"));
    }

    /** Runs held by this worker: acknowledged intent, dispatched or running. */
    async active(): Promise<AfkRun[]> {
        return runs(await this.#call("GET", "/internal/agency/afk/active"));
    }

    async acknowledge(intentId: string, ownerJobRef: string): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/intents/${enc(intentId)}/ack`, {
                ownerJobRef,
            }),
        );
    }

    async claim(runId: string, leaseSeconds: number): Promise<{ fence: number } | undefined> {
        const response = await this.#call("POST", `/internal/agency/runs/${enc(runId)}/claim`, {
            workerId: this.#endpoint.workerId,
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
            await this.#call("POST", `/internal/agency/runs/${enc(runId)}/heartbeat`, {
                fence,
                leaseSeconds,
            }),
        );
    }

    /** One short progress line; the text is the module's own, never a tool input. */
    async progress(runId: string, fence: number, text: string): Promise<AgencyAnswer> {
        return answer(
            await this.#call("POST", `/internal/agency/runs/${enc(runId)}/publish`, {
                fence,
                eventType: "afk.progress",
                agentId: this.#endpoint.workerId,
                toolId: null,
                payload: { text: text.slice(0, 300) },
            }),
        );
    }

    async receipt(runId: string, fence: number, receipt: unknown): Promise<AgencyAnswer> {
        const response = await this.#call("POST", `/internal/agency/runs/${enc(runId)}/artifacts`, {
            fence,
            agentId: this.#endpoint.workerId,
            kind: "afk.receipt",
            name: "receipt.json",
            mediaType: "application/json",
            contentBase64: Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
            inputs: [],
        });
        if (response.status === 200 || response.status === 201) return { ok: true, final: false };
        return answer(response);
    }

    /** The stored approval for this key: a replay returns the row already there. `undefined` = 409. */
    async requestApproval(
        runId: string,
        fence: number,
        request: AfkApprovalRequest,
    ): Promise<AfkApproval | undefined> {
        const response = await this.#call("POST", `/internal/agency/afk/${enc(runId)}/approvals`, {
            fence,
            ...request,
        });
        if (response.status === 409 || response.status === 404) return undefined;
        if (response.status !== 200 || !Value.Check(afkApprovalSchema, response.body)) {
            throw new Error(`Orkest approval answered ${response.status}.`);
        }
        return response.body;
    }

    async approval(runId: string, key: string): Promise<AfkApproval | undefined> {
        const response = await this.#call(
            "GET",
            `/internal/agency/afk/${enc(runId)}/approvals/${enc(key)}`,
        );
        if (response.status === 404) return undefined;
        if (response.status !== 200 || !Value.Check(afkApprovalSchema, response.body)) {
            throw new Error(`Orkest approval answered ${response.status}.`);
        }
        return response.body;
    }

    async complete(runId: string, fence: number, completion: AfkCompletion): Promise<AgencyAnswer> {
        const body =
            completion.kind === "proposed"
                ? { fence, proposed: true, consumed: 1, reason: "done" }
                : completion.kind === "declined"
                  ? {
                        fence,
                        proposed: false,
                        consumed: 1,
                        reason: completion.reason,
                        outcome: "declined",
                    }
                  : { fence, proposed: false, consumed: 1, reason: completion.reason };
        return answer(
            await this.#call("POST", `/internal/agency/runs/${enc(runId)}/complete`, body),
        );
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
                "X-Orkest-Worker-Token": this.#endpoint.workerToken,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 500) throw new Error(`Orkest answered ${response.status}.`);
        if (response.status === 401 || response.status === 403) {
            throw new Error(`Orkest refused the worker (${response.status}).`);
        }
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

function enc(value: string): string {
    return encodeURIComponent(value);
}

function runs(response: { status: number; body: unknown }): AfkRun[] {
    if (response.status !== 200 || !Array.isArray(response.body)) {
        throw new Error(`Orkest answered ${response.status}.`);
    }
    return response.body.filter((item): item is AfkRun => Value.Check(afkRunSchema, item));
}

function answer(response: { status: number; body: unknown }): AgencyAnswer {
    if (response.status === 200) return { ok: true, final: false };
    // 404 gone, 409 revoked/stale/conflict: the run is no longer this owner's.
    if (response.status === 404 || response.status === 409) return { ok: false, final: true };
    throw new Error(`Orkest answered ${response.status}.`);
}
