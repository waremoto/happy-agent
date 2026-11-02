import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { codexAppServerConnect } from "@/vendors/codexAppServer/codexAppServerConnect.js";

const SERVER = fileURLToPath(new URL("./fixtures/scriptedAppServer.mjs", import.meta.url));

async function connect(
    updates: string[],
    requestPermission: acp.Client["requestPermission"] = async () => ({
        outcome: { outcome: "cancelled" },
    }),
    texts: string[] = [],
): Promise<AcpConnection> {
    const client = {
        requestPermission,
        sessionUpdate: async (params: acp.SessionNotification) => {
            // A slow client: the turn's end must still wait for this update.
            await new Promise((resolve) => setTimeout(resolve, 50));
            updates.push(params.update.sessionUpdate);
            if (
                params.update.sessionUpdate === "agent_message_chunk" &&
                params.update.content.type === "text"
            ) {
                texts.push(params.update.content.text);
            }
        },
    } as acp.Client;
    return await codexAppServerConnect({ command: process.execPath, args: [SERVER] })(
        mkdtempSync(join(tmpdir(), "codex-app-server-")),
        client,
    );
}

describe("codexAppServerConnect", () => {
    it("ends a turn only after the updates Codex sent before it", async () => {
        const updates: string[] = [];
        const connection = await connect(updates);
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            const response = await connection.conn.prompt({
                sessionId,
                prompt: [{ type: "text", text: "hello" }],
            });
            expect(response.stopReason).toBe("end_turn");
            expect(updates).toEqual(["agent_message_chunk"]);
        } finally {
            connection.terminate();
        }
    });

    it("reports a failed turn as an error instead of an empty answer", async () => {
        const connection = await connect([]);
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await expect(
                connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "fail" }] }),
            ).rejects.toThrow("429");
        } finally {
            connection.terminate();
        }
    });

    it("asks before stepping outside the sandbox only under on-request, with the exact command", async () => {
        const asked: acp.RequestPermissionRequest[] = [];
        const texts: string[] = [];
        const connection = await connect(
            [],
            async (params) => {
                asked.push(params);
                return { outcome: { outcome: "selected", optionId: "decline" } };
            },
            texts,
        );
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await connection.conn.setSessionConfigOption({
                sessionId,
                configId: "approval_policy",
                value: "on-request",
            } as acp.SetSessionConfigOptionRequest);
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "ask" }] });
            expect(texts.join("")).toBe("decision:decline|policy:on-request");
            expect(asked).toHaveLength(1);
            expect(asked[0]!.toolCall).toMatchObject({
                toolCallId: "cmd-1",
                title: "touch outside.txt",
                rawInput: {
                    method: "item/commandExecution/requestApproval",
                    command: "touch outside.txt",
                    cwd: "/workspace",
                    reason: "Needs to write outside the sandbox",
                },
            });
        } finally {
            connection.terminate();
        }
    });

    it("shows the paths and diffs a file change approval would write", async () => {
        const asked: acp.RequestPermissionRequest[] = [];
        const connection = await connect([], async (params) => {
            asked.push(params);
            return { outcome: { outcome: "selected", optionId: "decline" } };
        });
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "edit" }] });
            expect(asked).toHaveLength(1);
            expect(asked[0]!.toolCall).toMatchObject({
                toolCallId: "fc-1",
                title: "Edit /workspace/a.txt",
                rawInput: {
                    method: "item/fileChange/requestApproval",
                    changes: [{ path: "/workspace/a.txt", kind: { type: "add" }, diff: "hello\n" }],
                },
            });
        } finally {
            connection.terminate();
        }
    });

    it("relays an allow once as accept", async () => {
        const texts: string[] = [];
        const connection = await connect(
            [],
            async () => ({ outcome: { outcome: "selected", optionId: "accept" } }),
            texts,
        );
        try {
            const { sessionId } = await connection.conn.newSession({
                cwd: tmpdir(),
                mcpServers: [],
            });
            await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "ask" }] });
            // Without a person, the policy Codex is given stays never.
            expect(texts.join("")).toBe("decision:accept|policy:never");
        } finally {
            connection.terminate();
        }
    });
});
