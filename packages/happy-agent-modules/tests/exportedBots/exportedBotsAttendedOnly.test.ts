import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type { AgentSystemRef } from "@slopus/happy-agent-base";

import type { ExportedBotAdapter } from "../../sources/exportedBots/ExportedBotAdapter.js";
import { exportedBotMigrations } from "../../sources/exportedBots/ExportedBotMigrations.js";
import { ExportedBotsModule } from "../../sources/exportedBots/ExportedBotsModule.js";
import { writeExportedBot } from "../../sources/exportedBots/ExportedBotStore.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/** Every adapter the module builds is this one, so a started export is one `run` call. */
const runs: string[] = [];
vi.mock("../../sources/exportedBots/exportedBotAdapters.js", () => ({
    createExportedBotAdapters: (): readonly ExportedBotAdapter[] => [
        {
            kind: "telegram",
            settingsSchema: Type.Unknown(),
            names: () => ({ service: "Telegram", account: "Telegram bot" }),
            guestScope: () => "",
            formattingInstructions: "",
            run: async (ctx: { lifetime?: AbortSignal }, connection: { botId: string }) => {
                runs.push(connection.botId);
                await new Promise<void>((resolve) => {
                    if (ctx.lifetime?.aborted === true) resolve();
                    ctx.lifetime?.addEventListener("abort", () => resolve(), { once: true });
                });
            },
        } as unknown as ExportedBotAdapter,
    ],
}));

type Params = ConstructorParameters<typeof ExportedBotsModule>;

const BOT_ID = "botaaaaaaaaaaaaaaaaaaaaa";

/** An enabled export of an active bot, started by a daemon that has just come up. */
async function startupRuns(attendedOnly: boolean): Promise<readonly string[]> {
    runs.length = 0;
    const database = moduleDatabase(exportedBotMigrations, "exported-bots-attended-only");
    await database.ready;
    const module = new ExportedBotsModule(
        { attendedOnly } as unknown as Params[0],
        {
            list: async () => [{ id: BOT_ID, status: "active" }],
            onEvent: () => () => undefined,
        } as unknown as Params[1],
        {} as Params[2],
        { register: vi.fn() } as unknown as Params[3],
        {} as Params[4],
        {} as Params[5],
        {} as Params[6],
    );
    try {
        const hooks = module.beforeStart(database.context, {} as AgentSystemRef);
        await writeExportedBot(database.context, {
            botId: BOT_ID,
            kind: "telegram",
            account: "123456",
            settings: { token: "test-token" },
            allowedUsers: [],
            unknownSenders: "ask",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
        });
        await hooks.afterStart!(database.context, {} as never);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [...runs];
    } finally {
        await module.close();
        database.close();
    }
}

describe("exported bots on an attended-only installation", () => {
    it("control: an ordinary installation connects an enabled export at startup", async () => {
        expect(await startupRuns(false)).toEqual([BOT_ID]);
    });

    it("starts no adapter, so no inbound chat can start a turn", async () => {
        expect(await startupRuns(true)).toEqual([]);
    });
});
