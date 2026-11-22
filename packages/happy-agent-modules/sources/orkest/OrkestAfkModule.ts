import { createHash } from "node:crypto";

import type { AgentModule, AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { TasksModule } from "../tasks/index.js";

/**
 * Happy as the unattended (AFK) owner of Orkest runs (GHO-189.3). Skeleton: not implemented yet.
 */
export class OrkestAfkModule implements AgentModule {
    readonly name = "orkest-afk";
    readonly #config: ConfigModule;
    readonly #tasks: TasksModule;
    #status: "disabled" | "refused" | "running" = "disabled";
    #lastError: string | null = null;

    constructor(config: ConfigModule, tasks: TasksModule) {
        this.#config = config;
        this.#tasks = tasks;
    }

    get status(): { state: string; runs: number; lastError: string | null } {
        void this.#config;
        void this.#tasks;
        return { state: this.#status, runs: 0, lastError: this.#lastError };
    }

    readonly beforeStart = (_ctx: Context, _agents: AgentSystemRef): AgentModuleHooks => ({});

    async close(): Promise<void> {}
}

/** A stable Happy identity for one AFK run, salted apart from the attended owner's identities. */
export function afkDerivedId(kind: "t" | "w" | "a" | "m", seed: string): string {
    return `k${kind}${createHash("sha256").update(`orkest-afk:${kind}:${seed}`).digest("hex").slice(0, 24)}`;
}

/** The run's task folder name: recognisable as an AFK run, stable across restarts. */
export function afkFolderName(runId: string): string {
    return `orkest_afk_${createHash("sha256").update(`orkest-afk:f:${runId}`).digest("hex").slice(0, 24)}`;
}
