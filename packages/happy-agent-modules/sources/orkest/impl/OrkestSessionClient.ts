/** GHO-196.1.2 — stub; the client lands with its implementation. */
export interface OrkestSessionEndpoint {
    readonly url: string;
    readonly workerToken: string;
}
export interface OrkestSessionCall {
    readonly session: string;
    readonly fence: number;
    readonly projectId: string;
}
export type OrkestSessionAnswer =
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | {
          readonly ok: false;
          readonly status: number;
          readonly error: string;
          readonly data?: unknown;
      };

export class OrkestSessionClient {
    constructor(_endpoint: OrkestSessionEndpoint) {}
    async tool(
        _name: string,
        _call: OrkestSessionCall,
        _args: Record<string, unknown>,
    ): Promise<OrkestSessionAnswer> {
        return { ok: false, status: 0, error: "not_implemented" };
    }
    async propose(
        _call: OrkestSessionCall,
        _input: Record<string, unknown>,
    ): Promise<OrkestSessionAnswer> {
        return { ok: false, status: 0, error: "not_implemented" };
    }
}
