import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";

describe("attended native Claude scheduling", () => {
    it.each([false, true])(
        "removes scheduling on new and resumed sessions (resume=%s)",
        async (resume) => {
            sdk.query.mockReturnValue({
                supportedModels: async () => [],
                close: vi.fn(),
                async *[Symbol.asyncIterator]() {},
            });
            const requestPermission = vi
                .fn()
                .mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow" } });
            const client = { requestPermission, sessionUpdate: vi.fn() } as unknown as acp.Client;
            const connection = await claudeCodeAgent.connect({ env: {}, attendedOnly: true })(
                "/work",
                client,
            );
            if (resume)
                await connection.conn.resumeSession!({
                    sessionId: "resumed",
                    cwd: "/work",
                    mcpServers: [],
                });
            else await connection.conn.newSession({ cwd: "/work", mcpServers: [] });
            const options = sdk.query.mock.lastCall![0].options;
            expect(options.disallowedTools).toEqual(
                expect.arrayContaining(["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"]),
            );
            for (const tool of ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"]) {
                expect(await options.canUseTool(tool, {}, { toolUseID: "test" })).toMatchObject({
                    behavior: "deny",
                });
            }
            expect(requestPermission).not.toHaveBeenCalled();
            expect(
                await options.canUseTool(
                    "Write",
                    { file_path: "/work/proof.txt" },
                    { toolUseID: "write" },
                ),
            ).toMatchObject({ behavior: "allow" });
            expect(requestPermission).toHaveBeenCalledOnce();
            connection.terminate();
        },
    );

    it("preserves ordinary installations", async () => {
        sdk.query.mockReturnValue({
            supportedModels: async () => [],
            close: vi.fn(),
            async *[Symbol.asyncIterator]() {},
        });
        const connection = await claudeCodeAgent.connect({ env: {} })("/work", {
            sessionUpdate: vi.fn(),
        } as unknown as acp.Client);
        await connection.conn.newSession({ cwd: "/work", mcpServers: [] });
        expect(sdk.query.mock.lastCall![0].options.disallowedTools).toBeUndefined();
        connection.terminate();
    });
});
