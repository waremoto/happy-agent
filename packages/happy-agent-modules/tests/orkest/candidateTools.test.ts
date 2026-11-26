import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    safeRepoPath,
    ticketCandidateTools,
    verifyCandidateTools,
    type CandidateAnswer,
    type CandidateClient,
    type CandidateForVerify,
    type ProposeCandidateInput,
    type RecordCheckInput,
} from "../../sources/orkest/impl/candidateTools.js";

// GHO-209 (ORKEST-REAL-APPROVAL) phase 3 — a ticket session's agent proposes a real change, built as one commit
// beside the repository (branch, index and working tree untouched); a verify session reads that exact change and
// records a receipt whose only subject is it.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orkest-candidate-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    await writeFile(join(dir, "README.md"), "hello\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
}

class FakeClient implements CandidateClient {
    proposed: { runId: string; fence: number; input: ProposeCandidateInput }[] = [];
    receipts: { runId: string; fence: number; input: RecordCheckInput }[] = [];
    constructor(
        private readonly answer: CandidateAnswer = { ok: true, id: "cand-1" },
        private readonly candidate: CandidateForVerify | null = null,
    ) {}
    async proposeCandidate(runId: string, fence: number, input: ProposeCandidateInput) {
        this.proposed.push({ runId, fence, input });
        return this.answer;
    }
    async readCandidate() {
        return this.candidate;
    }
    async recordReceipt(runId: string, fence: number, input: RecordCheckInput) {
        this.receipts.push({ runId, fence, input });
        return this.answer;
    }
}

const run = (tool: { execute: (...a: never[]) => unknown }, args: unknown) =>
    (tool.execute as (ctx: Context, args: unknown, extra: never) => Promise<string>)(
        {} as Context,
        args,
        {} as never,
    );

const ask = { checked: "README wording", action: "add a line", reason: "it changes the repo" };

describe("propose_change", () => {
    it("builds one commit on HEAD without touching the branch, index or working tree, and publishes its exact diff", async () => {
        const dir = await repo();
        const head = git(dir, "rev-parse", "HEAD");
        const client = new FakeClient();
        const [tool] = ticketCandidateTools({
            client,
            runId: "run-1",
            fence: () => 7,
            agentId: "happy:lab1/a1",
            workLabel: "MM-62",
            repoPath: dir,
        });

        const text = await run(tool!, {
            title: "Greet the world",
            files: [{ path: "README.md", content: "hello\nworld\n" }],
            ...ask,
        });

        expect(text).toContain("Proposed as change cand-1");
        expect(client.proposed).toHaveLength(1);
        const { runId, fence, input } = client.proposed[0]!;
        expect([runId, fence, input.workItemProvider, input.workItemId, input.agentId]).toEqual([
            "run-1",
            7,
            "multica",
            "MM-62",
            "happy:lab1/a1",
        ]);
        expect(input.ask).toEqual(ask);
        expect(input.git.baseSha).toBe(head);
        expect(git(dir, "rev-parse", `${input.git.sha}^`)).toBe(head);
        expect(input.git.branch).toMatch(/^refs\/orkest\/candidates\/MM-62\//);
        expect(git(dir, "rev-parse", input.git.branch!)).toBe(input.git.sha);
        const patch = Buffer.from(input.patchBase64, "base64").toString("utf8");
        expect(patch).toBe(git(dir, "diff", "--binary", head, input.git.sha) + "\n");
        expect(patch).toContain("+world");
        // Nothing the person has checked out moved.
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(git(dir, "status", "--porcelain")).toBe("");
        expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
    });

    it("refuses a path outside the repository and an unchanged file, publishing nothing", async () => {
        const dir = await repo();
        const client = new FakeClient();
        const [tool] = ticketCandidateTools({
            client,
            runId: "r",
            fence: () => 1,
            agentId: "a",
            workLabel: "MM-62",
            repoPath: dir,
        });

        expect(
            await run(tool!, {
                title: "x",
                files: [{ path: "../evil.txt", content: "x" }],
                ...ask,
            }),
        ).toContain("Refused path");
        expect(
            await run(tool!, {
                title: "x",
                files: [{ path: ".git/config", content: "x" }],
                ...ask,
            }),
        ).toContain("Refused path");
        expect(
            await run(tool!, {
                title: "x",
                files: [{ path: "README.md", content: "hello\n" }],
                ...ask,
            }),
        ).toContain("no change to propose");
        expect(client.proposed).toHaveLength(0);
    });

    it("says so when the project has no repository, and relays Father's refusal", async () => {
        const none = ticketCandidateTools({
            client: new FakeClient(),
            runId: "r",
            fence: () => 1,
            agentId: "a",
            workLabel: "MM-62",
            repoPath: null,
        });
        expect(
            await run(none[0]!, { title: "x", files: [{ path: "a", content: "b" }], ...ask }),
        ).toContain("no repository");

        const dir = await repo();
        const refused = ticketCandidateTools({
            client: new FakeClient({ ok: false, reason: "lease_lost (409)" }),
            runId: "r",
            fence: () => 1,
            agentId: "a",
            workLabel: "MM-62",
            repoPath: dir,
        });
        expect(
            await run(refused[0]!, {
                title: "x",
                files: [{ path: "new.txt", content: "b" }],
                ...ask,
            }),
        ).toBe("Orkest refused the proposal: lease_lost (409).");
    });

    it("normalizes repo paths", () => {
        expect(safeRepoPath("./src\\a.ts")).toBe("src/a.ts");
        expect(safeRepoPath("C:/x")).toBeNull();
        expect(safeRepoPath("/etc/passwd")).toBeNull();
        expect(safeRepoPath("a/../../b")).toBeNull();
    });
});

describe("verify tools", () => {
    const candidate: CandidateForVerify = {
        candidateId: "c-9",
        sha256: "ab".repeat(32),
        title: "Greet",
        workItem: "multica:MM-62",
        workLabel: "MM-62",
        git: { repo: "D:/r", baseSha: "b".repeat(40), sha: "c".repeat(40) },
        producerId: "happy:lab1/a1",
        patchBase64: Buffer.from("+world\n").toString("base64"),
        request: { checked: "x", action: "y", reason: "z" },
    };

    it("reads the exact change, then records a receipt whose only subject is it", async () => {
        const client = new FakeClient({ ok: true, id: "rcpt-1" }, candidate);
        const [read, record] = verifyCandidateTools({
            client,
            runId: "run-v",
            fence: () => 3,
            agentId: "happy:lab1/a2",
            agentName: "Checker",
        });

        const shown = await run(read!, {});
        expect(shown).toContain("Proposed change c-9 on MM-62: Greet");
        expect(shown).toContain("+world");
        expect(
            await run(record!, {
                verdict: "pass",
                reason: "applies and matches the ticket",
                checkSet: "read diff",
            }),
        ).toContain("Recorded: pass");
        expect(client.receipts).toEqual([
            {
                runId: "run-v",
                fence: 3,
                input: {
                    verifierId: "happy:lab1/a2",
                    verifierName: "Checker",
                    candidateId: "c-9",
                    sha256: candidate.sha256,
                    checkSet: "read diff",
                    verdict: "pass",
                    reason: "applies and matches the ticket",
                },
            },
        ]);
    });

    it("records nothing when Father gave the session no change", async () => {
        const client = new FakeClient({ ok: true }, null);
        const [, record] = verifyCandidateTools({
            client,
            runId: "r",
            fence: () => 1,
            agentId: "a",
        });
        expect(await run(record!, { verdict: "pass", reason: "r", checkSet: "c" })).toContain(
            "no proposed change",
        );
        expect(client.receipts).toHaveLength(0);
    });
});
