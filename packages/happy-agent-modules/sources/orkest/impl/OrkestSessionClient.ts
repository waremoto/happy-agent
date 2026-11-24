/**
 * GHO-196 — the Happy adapter's client for Orkest's project session seam (GHO-195): the dashboard's session tools API
 * (`/internal/orkest/session/tools/<tool>`) and its proposal route (`/internal/orkest/session/proposal`).
 *
 * Every call carries this worker's own Orkest token (`X-Orkest-Worker-Token`) and the session's `{session, fence,
 * projectId}`. The dashboard asks Father whether this worker holds that run with that fence and whether the run is a
 * project or doc session of that project, then reads or proposes as the person who started the session. The edge
 * path is refused by the dashboard, so the URL is its local origin.
 *
 * Answers are typed, never thrown, for every status the seam defines (a refusal is something the agent should read);
 * a 5xx or a network failure throws, so a caller can say the seam is unavailable. No token is ever in a message.
 */

export interface OrkestSessionEndpoint {
    /** The dashboard's local origin, e.g. `http://127.0.0.1:3002`. */
    readonly url: string;
    /** This worker's own Orkest token. */
    readonly workerToken: string;
}

/** The three fields every session call names. */
export interface OrkestSessionCall {
    readonly session: string;
    readonly fence: number;
    readonly projectId: string;
}

export interface OrkestProposalInput {
    readonly path: string;
    /** The git blob the text was made from; `null` proposes a new doc (held for the person). */
    readonly baseRev: string | null;
    readonly text: string;
    readonly why: string;
    readonly turn: string;
    readonly model?: string;
    readonly agentSessionId?: string;
}

export type OrkestSessionAnswer =
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | {
          readonly ok: false;
          readonly status: number;
          readonly error: string;
          readonly data?: unknown;
      };

/**
 * The tools the seam serves (GHO-195 `ORKEST_SESSION_TOOLS`, and GHO-199's orchestrator tools). There is no answer
 * tool: the dashboard refuses every name for one, and this client does not send them.
 */
export const ORKEST_SESSION_TOOLS = [
    "list_docs",
    "read_doc",
    "list_trackers",
    "read_tracker",
    "list_tickets",
    "read_ticket",
    "list_runs",
    "read_run",
    "start_run",
    "propose_ticket",
    "stop_run",
    "list_children",
    "list_requests",
    "read_notes",
    "ack_notes",
    "reconcile_roadmap",
    // GHO-205.3.2: the session's main doc, asked before every turn (an older dashboard answers 404).
    "focus",
] as const;
export type OrkestSessionToolName = (typeof ORKEST_SESSION_TOOLS)[number];

const TIMEOUT_MS = 30_000;

export class OrkestSessionClient {
    readonly #endpoint: OrkestSessionEndpoint;

    constructor(endpoint: OrkestSessionEndpoint) {
        this.#endpoint = {
            url: endpoint.url.replace(/\/+$/, ""),
            workerToken: endpoint.workerToken,
        };
    }

    /** One read through the tools API. The call's own fields win over an argument of the same name. */
    async tool(
        name: string,
        call: OrkestSessionCall,
        args: Record<string, unknown>,
    ): Promise<OrkestSessionAnswer> {
        if (!(ORKEST_SESSION_TOOLS as readonly string[]).includes(name))
            throw new Error(`unknown session tool ${JSON.stringify(name).slice(0, 60)}`);
        return this.#post(`/internal/orkest/session/tools/${name}`, { ...args, ...callOf(call) });
    }

    /** The whole proposed document for one path. */
    async propose(
        call: OrkestSessionCall,
        input: OrkestProposalInput,
    ): Promise<OrkestSessionAnswer> {
        return this.#post("/internal/orkest/session/proposal", { ...input, ...callOf(call) });
    }

    async #post(path: string, body: Record<string, unknown>): Promise<OrkestSessionAnswer> {
        let response: Response;
        try {
            response = await fetch(`${this.#endpoint.url}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Orkest-Worker-Token": this.#endpoint.workerToken,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error ? error.name : "error";
            throw new Error(`Orkest session seam unreachable (${reason}).`);
        }
        const text = await response.text();
        let parsed: unknown = null;
        try {
            parsed = text.length === 0 ? null : JSON.parse(text);
        } catch {
            parsed = null;
        }
        if (response.status >= 500)
            throw new Error(`Orkest session seam answered ${response.status}.`);
        if (response.status >= 200 && response.status < 300)
            return { ok: true, status: response.status, body: parsed };
        const record = (parsed ?? {}) as {
            statusMessage?: unknown;
            message?: unknown;
            data?: unknown;
        };
        const data = record.data;
        const named =
            typeof record.statusMessage === "string" && record.statusMessage.length > 0
                ? record.statusMessage
                : typeof (data as { error?: unknown } | undefined)?.error === "string"
                  ? (data as { error: string }).error
                  : `http_${response.status}`;
        return data === undefined
            ? { ok: false, status: response.status, error: named }
            : { ok: false, status: response.status, error: named, data };
    }
}

function callOf(call: OrkestSessionCall): OrkestSessionCall {
    return { session: call.session, fence: call.fence, projectId: call.projectId };
}
