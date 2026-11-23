import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type {
    OrkestProposalInput,
    OrkestSessionAnswer,
    OrkestSessionClient,
} from "../../sources/orkest/impl/OrkestSessionClient.js";
import { projectSessionTools } from "../../sources/orkest/impl/projectSessionTools.js";
import { writeWorkingCopy } from "../../sources/orkest/impl/projectSessionWorkspace.js";

// GHO-200.3.3 (project session stage 7) — a Botanic note whose owner set it to view for AI is refused by the
// dashboard with 403 read_only_for_ai before any room write; the agent is told so in plain words.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function proposeWith(answer: OrkestSessionAnswer): Promise<{ text: string; sent: OrkestProposalInput[] }> {
    const taskPath = await mkdtemp(join(tmpdir(), "happy-ps-tools-"));
    dirs.push(taskPath);
    await writeWorkingCopy(taskPath, "docs/botanic/note-1.md", "# Note\n\n[0:42] the key point, shorter\n", "a".repeat(40));
    const sent: OrkestProposalInput[] = [];
    const client = {
        propose: async (_call: unknown, input: OrkestProposalInput) => {
            sent.push(input);
            return answer;
        },
    } as unknown as OrkestSessionClient;
    const tools = projectSessionTools({
        client,
        call: () => ({ session: "s1", fence: 1 }) as never,
        taskPath,
        taskId: "task-1",
        agentHome: join(taskPath, "no-home"),
        agentId: "agent-1",
        permissionMode: "workspace_write",
        model: () => "synthetic-model",
        turn: async () => "t1",
    });
    const tool = tools.find((t) => t.name === "propose_document")!;
    const text = (await tool.execute({} as Context, { path: "docs/botanic/note-1.md", why: "shorter" }, {} as never)) as string;
    return { text, sent };
}

describe("propose_document refusals", () => {
    it("says in plain words that a note read only for AI cannot be proposed to", async () => {
        const { text, sent } = await proposeWith({
            ok: false,
            status: 403,
            error: "read_only_for_ai",
            data: { error: "read_only_for_ai", path: "docs/botanic/note-1.md" },
        });
        expect(sent).toHaveLength(1);
        expect(text).toMatch(/read only for AI/);
        expect(text).toMatch(/Botanic/);
        expect(text).toMatch(/nothing was proposed/);
        expect(text).not.toMatch(/Orkest refused this/);
    });

    it("keeps the existing answers (a turn that already proposed)", async () => {
        const { text } = await proposeWith({ ok: false, status: 409, error: "already_proposed_this_turn" });
        expect(text).toMatch(/one proposal per turn/);
    });
});
