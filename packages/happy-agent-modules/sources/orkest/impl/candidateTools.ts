import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { Type } from "@sinclair/typebox";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";

/**
 * ORKEST-REAL-APPROVAL (Ghost GHO-209) — the tools that make an Orkest approval real end to end.
 *
 * - A ticket session's agent gets `propose_change`: it writes whole files, the tool builds one commit from them in
 *   the project's repository with git plumbing (a temporary index, `commit-tree`, a ref under
 *   `refs/orkest/candidates/`), and publishes the `base..sha` diff to Father as a proposed change with the agent's
 *   ask. The checked-out branch, the index and the working tree are never touched: a ticket session may not write
 *   the repository (GHO-204), and nothing here merges or pushes.
 * - A verify session's agent (opened by a person to check one proposed change) gets `read_candidate` and
 *   `record_check`. The receipt's only subject is the exact candidate Father gave this run, so a check can never be
 *   pointed at different bytes. Father refuses it if the checker is the producer.
 *
 * Neither tool can approve or reject: that is the person's, on the card.
 */

export interface CandidateGitIdentity {
    readonly repo: string;
    readonly baseSha: string;
    readonly sha: string;
    readonly branch?: string;
}

export interface CandidateAsk {
    readonly checked: string;
    readonly action: string;
    readonly reason: string;
    readonly agentName?: string;
    readonly agentRole?: string;
}

export interface ProposeCandidateInput {
    readonly agentId: string;
    readonly workItemProvider: string;
    readonly workItemId: string;
    readonly title: string;
    readonly patchBase64: string;
    readonly git: CandidateGitIdentity;
    readonly ask: CandidateAsk;
}

/** Father's owner-lane view of the change a verify run checks (`GET /internal/agency/runs/{runId}/candidate`). */
export interface CandidateForVerify {
    readonly candidateId: string;
    readonly sha256: string;
    readonly title: string;
    readonly workItem: string;
    readonly workLabel: string;
    readonly git: { readonly repo: string; readonly baseSha: string; readonly sha: string };
    readonly producerId: string;
    readonly patchBase64: string;
    readonly request?: {
        readonly checked: string;
        readonly action: string;
        readonly reason: string;
    } | null;
}

export interface RecordCheckInput {
    readonly verifierId: string;
    readonly verifierName?: string;
    readonly candidateId: string;
    readonly sha256: string;
    readonly checkSet: string;
    readonly verdict: "pass" | "fail" | "needs_review";
    readonly reason: string;
}

export interface CandidateAnswer {
    readonly ok: boolean;
    readonly id?: string;
    readonly reason?: string;
}

/** The three Father calls the tools make, with the run's fence. `OrkestAgencyClient` implements them. */
export interface CandidateClient {
    proposeCandidate(
        runId: string,
        fence: number,
        input: ProposeCandidateInput,
    ): Promise<CandidateAnswer>;
    readCandidate(runId: string): Promise<CandidateForVerify | null>;
    recordReceipt(runId: string, fence: number, input: RecordCheckInput): Promise<CandidateAnswer>;
}

export type GitRun = (
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
) => Promise<string>;

export const gitRun: GitRun = (args, options) =>
    new Promise((resolve, reject) => {
        const child = execFile(
            "git",
            [...args],
            {
                cwd: options.cwd,
                env: options.env ?? process.env,
                windowsHide: true,
                maxBuffer: 32 * 1024 * 1024,
            },
            (error, stdout, stderr) =>
                error
                    ? reject(new Error(`git ${args[0]}: ${stderr || error.message}`))
                    : resolve(stdout),
        );
        if (options.input !== undefined) child.stdin?.end(options.input);
    });

export interface CandidateFile {
    readonly path: string;
    readonly content: string;
}

/** A repo-relative path with forward slashes, or null when it leaves the repository or names git's own files. */
export function safeRepoPath(path: string): string | null {
    const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!trimmed || isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) return null;
    const parts = normalize(trimmed).replace(/\\/g, "/").split("/");
    if (parts.some((p) => p === ".." || p === "") || parts[0] === ".git") return null;
    return parts.join("/");
}

/**
 * One commit on top of HEAD with the given whole files, built without touching the branch, index or working tree.
 * Returns the base, the commit and the exact `git diff --binary base sha` bytes (with a final line feed).
 */
export async function buildCandidateCommit(
    git: GitRun,
    repoPath: string,
    files: readonly CandidateFile[],
    message: string,
    ref: string,
): Promise<{ baseSha: string; sha: string; patch: string; branch: string }> {
    if (files.length === 0) throw new Error("A proposed change needs at least one file.");
    const paths = files.map((f) => safeRepoPath(f.path));
    const bad = files.find((_, i) => paths[i] === null);
    if (bad) throw new Error(`Refused path "${bad.path}": use a path inside the repository.`);
    const baseSha = (await git(["rev-parse", "HEAD"], { cwd: repoPath })).trim();
    const index = join(tmpdir(), `orkest-candidate-${randomUUID()}.index`);
    const env = {
        ...process.env,
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: "Orkest agent",
        GIT_AUTHOR_EMAIL: "agent@orkest.invalid",
        GIT_COMMITTER_NAME: "Orkest agent",
        GIT_COMMITTER_EMAIL: "agent@orkest.invalid",
    };
    try {
        await git(["read-tree", baseSha], { cwd: repoPath, env });
        for (const [i, file] of files.entries()) {
            const blob = (
                await git(["hash-object", "-w", "--stdin"], {
                    cwd: repoPath,
                    env,
                    input: file.content,
                })
            ).trim();
            await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${paths[i]}`], {
                cwd: repoPath,
                env,
            });
        }
        const tree = (await git(["write-tree"], { cwd: repoPath, env })).trim();
        const sha = (
            await git(["commit-tree", tree, "-p", baseSha, "-m", message], { cwd: repoPath, env })
        ).trim();
        const branch = `refs/orkest/candidates/${ref}`;
        await git(["update-ref", branch, sha], { cwd: repoPath, env });
        let patch = await git(["diff", "--binary", baseSha, sha], { cwd: repoPath });
        if (!patch.trim())
            throw new Error(
                "The files are the same as the repository's; there is no change to propose.",
            );
        if (!patch.endsWith("\n")) patch += "\n";
        return { baseSha, sha, patch, branch };
    } finally {
        await rm(index, { force: true });
    }
}

export interface TicketToolsInput {
    readonly client: CandidateClient;
    readonly git?: GitRun;
    readonly runId: string;
    readonly fence: () => number;
    readonly agentId: string;
    readonly agentName?: string;
    /** The ticket's identifier (`MM-62`): the card keys a ticket's proposed changes on it. */
    readonly workLabel: string;
    /** The project's repository on this host; null when the project has none (the tool then says so). */
    readonly repoPath: string | null;
}

export function ticketCandidateTools(input: TicketToolsInput): readonly AnyAgentTool[] {
    const git = input.git ?? gitRun;
    return [
        defineAgentTool({
            name: "propose_change",
            shouldReviewInAutoMode: () => false,
            description:
                "Propose a change to the project's repository for this ticket. Give each changed file whole (its full new text) " +
                "with its repo-relative path, a short title, and the three parts of your ask: what you checked, what you want " +
                "to do, and why a person must approve it. The change is stored as one commit beside the repository (nothing is " +
                "merged or pushed) and shown to the person as an approval card. Someone else checks it before they can approve.",
            parameters: Type.Object({
                title: Type.String({ minLength: 1, maxLength: 300 }),
                files: Type.Array(
                    Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
                    { minItems: 1, maxItems: 50 },
                ),
                checked: Type.String({ minLength: 1, maxLength: 1000 }),
                action: Type.String({ minLength: 1, maxLength: 1000 }),
                reason: Type.String({ minLength: 1, maxLength: 1000 }),
            }),
            returnType: Type.String(),
            execute: async (_ctx, args) => {
                if (input.repoPath === null)
                    return "This ticket's project has no repository on this host, so a change cannot be proposed.";
                let built: Awaited<ReturnType<typeof buildCandidateCommit>>;
                try {
                    built = await buildCandidateCommit(
                        git,
                        input.repoPath,
                        args.files,
                        `${input.workLabel}: ${args.title}`,
                        `${input.workLabel}/${randomUUID().slice(0, 8)}`,
                    );
                } catch (error) {
                    return `Not proposed: ${(error as Error).message}`;
                }
                const answer = await input.client.proposeCandidate(input.runId, input.fence(), {
                    agentId: input.agentId,
                    workItemProvider: "multica",
                    workItemId: input.workLabel,
                    title: args.title,
                    patchBase64: Buffer.from(built.patch, "utf8").toString("base64"),
                    git: {
                        repo: input.repoPath,
                        baseSha: built.baseSha,
                        sha: built.sha,
                        branch: built.branch,
                    },
                    ask: {
                        checked: args.checked,
                        action: args.action,
                        reason: args.reason,
                        ...(input.agentName ? { agentName: input.agentName } : {}),
                    },
                });
                return answer.ok
                    ? `Proposed as change ${answer.id} (commit ${built.sha.slice(0, 7)} on ${built.baseSha.slice(0, 7)}). It waits for an independent check, then the person decides.`
                    : `Orkest refused the proposal: ${answer.reason ?? "unknown reason"}.`;
            },
            toLLM: (text) => [{ type: "text", text }],
        }),
    ];
}

export interface VerifyToolsInput {
    readonly client: CandidateClient;
    readonly runId: string;
    readonly fence: () => number;
    readonly agentId: string;
    readonly agentName?: string;
}

export function verifyCandidateTools(input: VerifyToolsInput): readonly AnyAgentTool[] {
    let seen: CandidateForVerify | null = null;
    const load = async () => (seen ??= await input.client.readCandidate(input.runId));
    return [
        defineAgentTool({
            name: "read_candidate",
            shouldReviewInAutoMode: () => false,
            description:
                "Read the proposed change you were asked to check: its ticket, the producer's ask, the repository, base and commit, " +
                "and the exact diff.",
            parameters: Type.Object({}),
            returnType: Type.String(),
            execute: async () => {
                const c = await load();
                if (!c) return "Orkest gave this session no proposed change to check.";
                const patch = Buffer.from(c.patchBase64, "base64").toString("utf8");
                return [
                    `Proposed change ${c.candidateId} on ${c.workLabel}: ${c.title}`,
                    `Repository ${c.git.repo}, base ${c.git.baseSha}, commit ${c.git.sha}. Proposed by ${c.producerId}.`,
                    c.request
                        ? `The producer checked ${c.request.checked}; wants to ${c.request.action}; because ${c.request.reason}.`
                        : "",
                    "",
                    patch,
                ].join("\n");
            },
            toLLM: (text) => [{ type: "text", text }],
        }),
        defineAgentTool({
            name: "record_check",
            shouldReviewInAutoMode: () => false,
            description:
                "Record your independent check of the proposed change, once: verdict pass, fail or needs_review, a reason a person " +
                'can read, and a short name for what you checked (for example "applies on base + read against the ticket").',
            parameters: Type.Object({
                verdict: Type.Union([
                    Type.Literal("pass"),
                    Type.Literal("fail"),
                    Type.Literal("needs_review"),
                ]),
                reason: Type.String({ minLength: 1, maxLength: 4000 }),
                checkSet: Type.String({ minLength: 1, maxLength: 200 }),
            }),
            returnType: Type.String(),
            execute: async (_ctx, args) => {
                const c = await load();
                if (!c) return "Orkest gave this session no proposed change to check.";
                const answer = await input.client.recordReceipt(input.runId, input.fence(), {
                    verifierId: input.agentId,
                    ...(input.agentName ? { verifierName: input.agentName } : {}),
                    candidateId: c.candidateId,
                    sha256: c.sha256,
                    checkSet: args.checkSet,
                    verdict: args.verdict,
                    reason: args.reason,
                });
                return answer.ok
                    ? `Recorded: ${args.verdict}. The person now sees your check on the card.`
                    : `Orkest refused the check: ${answer.reason ?? "unknown reason"}.`;
            },
            toLLM: (text) => [{ type: "text", text }],
        }),
    ];
}
