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
    return path; // GHO-209.3.1 red stub
}

export async function buildCandidateCommit(
    _git: GitRun,
    _repoPath: string,
    _files: readonly CandidateFile[],
    _message: string,
    _ref: string,
): Promise<{ baseSha: string; sha: string; patch: string; branch: string }> {
    throw new Error("not implemented");
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
            execute: async () => "Not implemented.",
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
            execute: async () => "Not implemented.",
            toLLM: (text) => [{ type: "text", text }],
        }),
    ];
}
