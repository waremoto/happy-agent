import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { OrkestSessionCall, OrkestSessionClient } from "./OrkestSessionClient.js";

/** GHO-199.4.1 red: the orchestrator tools, not built yet. */
export interface ProjectSessionOrchestratorInput {
    readonly client: OrkestSessionClient;
    readonly call: () => OrkestSessionCall;
    readonly permissionMode: string;
}

export function projectSessionOrchestratorTools(_input: ProjectSessionOrchestratorInput): readonly AnyAgentTool[] {
    return [];
}
