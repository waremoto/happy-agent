import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationModule } from "../../sources/collaboration/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { SubtasksModule } from "../../sources/subtasks/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(toml: string): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "happy-attended-refusals-"));
    roots.push(root);
    return await testConfigRootedAt(root, toml);
}

function subtasksOver(collaboration: CollaborationModule): SubtasksModule {
    return new SubtasksModule(
        {} as never,
        {} as never,
        collaboration,
        { onEventTransactional: vi.fn() } as never,
        { register: vi.fn() } as never,
        {} as never,
        {} as never,
    );
}

describe("attended-only refusals", () => {
    it("gives an agent no way to create a subtask, only to archive one", async () => {
        const ctx = createRootContext();
        const collaboration = new CollaborationModule(
            await config("[features]\nattended_only = true"),
            {} as never,
            {} as never,
            {} as never,
        );
        const hooks = subtasksOver(collaboration).beforeStart(ctx, {} as never);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", provider: "codex", model: undefined },
        } as never);
        expect(tools.map((tool) => tool.name)).toEqual(["archive_subtask"]);
    });
});
