import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAgentContext } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationModule } from "../../sources/collaboration/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { GoalModule } from "../../sources/goal/GoalModule.js";
import {
    GOAL_LAST_INFERENCE_KEY,
    GOAL_OBSERVED_LIFECYCLE_ID_KEY,
} from "../../sources/goal/impl/goalState.js";
import { recordingAgents } from "../goal/recordingAgents.js";
import {
    advance,
    schedulingHarness,
    TestAgents,
    useSchedulingClock,
} from "../scheduling/support/schedulingHarness.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const roots: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(toml: string): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "happy-attended-only-"));
    roots.push(root);
    return await testConfigRootedAt(root, toml);
}

const ATTENDED = ["[features]", "attended_only = true"].join("\n");

describe("attended-only installations", () => {
    it("turns off every switchable self-starting path in the effective configuration", async () => {
        const attended = await config(
            [
                ATTENDED,
                "workflows = true",
                "[feature.mobile_connector]",
                "enabled = true",
                "[settings]",
                "inference_max_retries = 7",
                "[peer_messaging]",
                "enabled = true",
                'node_id = "lab1"',
            ].join("\n"),
        );
        const values = attended.configuration.values;
        expect(attended.attendedOnly).toBe(true);
        expect(values.features.workflows).toBe(false);
        expect(values.feature.mobileConnector.enabled).toBe(false);
        expect(attended.mobileConnectorEnabled).toBe(false);
        expect(values.settings.inferenceMaxRetries).toBe(0);
        expect(attended.peerMessaging.enabled).toBe(false);

        const ordinary = await config('[peer_messaging]\nenabled = true\nnode_id = "lab1"');
        expect(ordinary.attendedOnly).toBe(false);
        expect(ordinary.configuration.values.features.workflows).toBe(true);
        expect(ordinary.configuration.values.settings.inferenceMaxRetries).toBe(10);
        expect(ordinary.peerMessaging.enabled).toBe(true);
    });

    it("offers no scheduled messages and never delivers one a previous process left pending", async () => {
        useSchedulingClock();
        const first = await schedulingHarness("attended-scheduling");
        await first.module.schedule(first.database.context, "agenta", {
            id: "pendingone",
            targetAgentId: "agentb",
            message: "Wake up",
            in: { minutes: 5 },
        });
        first.module.stop();

        const agents = new TestAgents();
        const restarted = await schedulingHarness("attended-scheduling", {
            agents,
            database: first.database,
            config: await config(ATTENDED),
        });
        try {
            const tools =
                (await restarted.hooks.tools?.(restarted.database.context, {
                    agent: { id: "agenta" },
                } as never)) ?? [];
            expect(tools.map((tool) => tool.name)).toEqual(["wait", "wait_until"]);
            await advance(10 * 60_000);
            expect(agents.delivered).toEqual([]);
        } finally {
            restarted.close();
            first.database.close();
        }
    });

    it("never lets a goal start a turn on its own", async () => {
        const module = new GoalModule(undefined, await config(ATTENDED));
        const database = moduleDatabase(module.migrations, "attended-goal");
        await database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const ctx = withAgentContext(database.context, {
            id: "agent-a",
            provider: "scripted",
            permissionMode: "auto",
        });
        const values = new Map<string, unknown>([
            [GOAL_OBSERVED_LIFECYCLE_ID_KEY, "lifecycle-a"],
            [GOAL_LAST_INFERENCE_KEY, { state: "normal" }],
        ]);
        const runKV = {
            read: async (_ctx: unknown, key: string) => values.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                values.set(key, value);
            },
            delete: async (_ctx: unknown, key: string) => {
                values.delete(key);
            },
        };
        try {
            // Set from outside the agent: ordinarily this wakes it.
            await module.setGoal(database.context, "agent-b", "ship it");
            expect(agents.wakes).toEqual([]);
            await module.setGoal(ctx, "agent-a", "ship it again", "lifecycle-a");
            const scope = { agent: { id: "agent-a" }, runKV } as never;
            expect(await hooks.afterAgentLoop!(ctx, scope, { loopId: "loop-a" })).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("keeps agents from creating or messaging other agents", async () => {
        const attended = new CollaborationModule(
            await config(ATTENDED),
            {} as never,
            {} as never,
            {} as never,
        );
        const ordinary = new CollaborationModule(
            await config(""),
            {} as never,
            {} as never,
            {} as never,
        );
        expect(attended.delegationAllowed).toBe(false);
        expect(ordinary.delegationAllowed).toBe(true);
    });
});
