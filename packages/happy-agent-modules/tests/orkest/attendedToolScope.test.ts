import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnyAgentTool, AgentModuleScope } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";

import { listArtifactsTool } from "../../sources/artifacts/tools/list_artifacts.js";
import { createBotTool } from "../../sources/bots/tools/create_bot.js";
import { sendBotMessageTool } from "../../sources/bots/tools/send_bot_message.js";
import { setBotAvatarTool } from "../../sources/bots/tools/set_bot_avatar.js";
import { setBotNameTool } from "../../sources/bots/tools/set_bot_name.js";
import { updateBotSettingsTool } from "../../sources/bots/tools/update_bot_settings.js";
import { setBridgeExportedBotTool } from "../../sources/exportedBots/bridge/set_bridge_exported_bot.js";
import { setTelegramExportedBotTool } from "../../sources/exportedBots/telegram/set_telegram_exported_bot.js";
import { approveExportedBotUserTool } from "../../sources/exportedBots/tools/approve_exported_bot_user.js";
import { denyExportedBotUserTool } from "../../sources/exportedBots/tools/deny_exported_bot_user.js";
import { removeExportedBotTool } from "../../sources/exportedBots/tools/remove_exported_bot.js";
import { createMcpConfigurationTools } from "../../sources/mcp/createMcpConfigurationTools.js";
import { OrkestModule } from "../../sources/orkest/index.js";
import { attachSecretTool } from "../../sources/secrets/tools/attach_secret.js";
import { createSecretTool } from "../../sources/secrets/tools/create_secret.js";
import { detachSecretTool } from "../../sources/secrets/tools/detach_secret.js";
import { listSecretsTool } from "../../sources/secrets/tools/list_secrets.js";
import { referenceSecretTool } from "../../sources/secrets/tools/reference_secret.js";
import { updateSecretTool } from "../../sources/secrets/tools/update_secret.js";
import { calendarTools } from "../../sources/surfaces/tools/calendarTools.js";
import { testConfigRootedAt } from "../support/configModule.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * ORKEST-AGENCY.4.4d — the 2026-11-02 probe found an attended Read only session offered about 90
 * Happy tools, among them secrets, MCP configuration, bot messaging and calendar writes, and
 * `list_artifacts` defaulting to every task's artifacts. The tools here come from their real
 * factories, so a renamed tool shows up as one this scope no longer hides.
 */
function realTools(): AnyAgentTool[] {
    const stub = {} as never;
    const mcp = { userMcpConfigLocation: () => "/home/user/.happy/mcp.toml" } as never;
    return [
        createSecretTool(stub, "a"),
        updateSecretTool(stub, "a"),
        attachSecretTool(stub, "a"),
        detachSecretTool(stub, "a"),
        listSecretsTool(stub, "a"),
        referenceSecretTool(stub, "a"),
        ...createMcpConfigurationTools(mcp, "a"),
        sendBotMessageTool(stub, "a"),
        createBotTool(stub, "a"),
        updateBotSettingsTool(stub, stub, "a"),
        setBotNameTool(stub, "a"),
        setBotAvatarTool(stub, "a"),
        approveExportedBotUserTool(stub, "a"),
        denyExportedBotUserTool(stub, "a"),
        removeExportedBotTool(stub, "a"),
        setTelegramExportedBotTool(stub, "a", stub),
        setBridgeExportedBotTool(stub, "a"),
        ...calendarTools(stub, stub),
        listArtifactsTool(stub, "a"),
    ] as AnyAgentTool[];
}

const HIDDEN = [
    "create_secret",
    "update_secret",
    "attach_secret",
    "detach_secret",
    "list_secrets",
    "reference_secret",
    "configure_mcp_server",
    "reload_mcp_servers",
    "send_bot_message",
    "create_bot",
    "update_bot_settings",
    "set_bot_name",
    "set_bot_avatar",
    "approve_exported_bot_user",
    "deny_exported_bot_user",
    "remove_exported_bot",
    "set_telegram_exported_bot",
    "set_bridge_exported_bot",
    "create_calendar_event",
    "update_calendar_event",
    "delete_calendar_event",
];

async function scoped(attendedOnly: boolean, tools: readonly AnyAgentTool[]) {
    const root = await mkdtemp(join(tmpdir(), "happy-attended-scope-"));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    const config = await testConfigRootedAt(root, `[features]\nattended_only = ${attendedOnly}\n`);
    const hooks = new OrkestModule(config, {} as never).beforeStart({} as never, {} as never);
    const scope = { agent: { id: "a", provider: "scripted" } } as unknown as AgentModuleScope;
    const result = hooks.overrideTools
        ? await hooks.overrideTools({} as never, scope, {
              selection: {} as never,
              contributions: [],
              tools,
          })
        : tools;
    return result.map((tool) => tool.name);
}

describe("attended-only tool scope", () => {
    it("hides secrets, MCP configuration, bot writes and calendar writes on an attended-only installation", async () => {
        const tools = realTools();
        const names = tools.map((tool) => tool.name);
        for (const hidden of HIDDEN)
            expect(names, `${hidden} is still a real tool`).toContain(hidden);

        const attended = await scoped(true, tools);
        expect(attended.filter((name) => HIDDEN.includes(name))).toEqual([]);
        // Reads that stay: the calendar's own reads and artifact listing (scoped below).
        expect(attended).toEqual(
            expect.arrayContaining([
                "list_calendar_events",
                "list_calendar_event_versions",
                "list_artifacts",
            ]),
        );
    });

    it("changes nothing on an ordinary installation", async () => {
        const tools = realTools();
        expect(await scoped(false, tools)).toEqual(tools.map((tool) => tool.name));
    });

    it("lists only this conversation's own artifacts when attended-only, whatever scope is asked", async () => {
        const queries: Array<Record<string, unknown>> = [];
        const artifacts = {
            actorFor: async () => ({ source: { kind: "task", taskId: "task-1" } }),
            list: async (_ctx: unknown, query: Record<string, unknown>) => {
                queries.push(query);
                return { artifacts: [] };
            },
        } as never;
        const run = async (hereOnly: boolean, scope: "all" | "here" | undefined) =>
            await listArtifactsTool(artifacts, "a", { hereOnly }).execute(
                {} as never,
                scope === undefined ? {} : { scope },
                {} as never,
            );

        await run(true, "all");
        await run(true, undefined);
        expect(queries.map((q) => [q["sourceKind"], q["sourceId"]])).toEqual([
            ["task", "task-1"],
            ["task", "task-1"],
        ]);
        queries.length = 0;
        await run(false, undefined);
        expect(queries[0]?.["sourceKind"]).toBeUndefined();
    });
});
