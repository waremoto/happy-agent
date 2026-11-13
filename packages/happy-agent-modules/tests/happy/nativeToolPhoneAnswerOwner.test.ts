import { afterEach, describe, expect, it } from "vitest";

import { HappyConnection } from "../../sources/happy/HappyConnection.js";
import type { TaskRecord } from "../../sources/tasks/index.js";
import type { TeamUser } from "../../sources/team/index.js";
import { nativeToolPermissionQuestion } from "../../sources/userInput/impl/nativeToolPermissionQuestion.js";
import {
    createUserInputDatabase,
    createUserInputModule,
} from "../userInput/userInputTestSupport.js";

/*
 * ORKEST-AGENCY 4.2c, the phone. A team member's paired phone answers and dismisses questions
 * through HappyConnection, not the HTTP route. A native tool's permission question there is the
 * task owner's too: another member may neither answer it nor dismiss it (dismissing denies the
 * action), the question stays pending, and the owner's answer records who gave it.
 */

const AGENT = "task-agent";
const OWNER: TeamUser = { id: "user-bob", isOwner: false } as TeamUser;
const MEMBER: TeamUser = { id: "user-carol", isOwner: false } as TeamUser;
const TASK = {
    id: "task-1",
    agentId: AGENT,
    workspaceId: "task-workspace",
    status: "active",
    ownerUserId: OWNER.id,
} as unknown as TaskRecord;

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function world() {
    const userInput = createUserInputModule();
    const database = createUserInputDatabase(userInput, "native-phone-owner");
    await database.ready;
    cleanups.push(() => database.close());
    userInput.beforeStart(database.context, { parentOf: async () => null } as never);
    const users = new Map([OWNER, MEMBER].map((user) => [user.id, user]));
    const team = { enabled: true, getUser: async (_ctx: unknown, id: string) => users.get(id) };
    // Both people are members of the task; only Bob owns it.
    const tasks = {
        forAgent: async (_ctx: unknown, agentId: string) => (agentId === AGENT ? TASK : undefined),
        memberFor: (userId: string | undefined) => userId,
        membership: async () => ({ taskId: TASK.id }),
        onEvent: () => () => undefined,
    };
    const config = { configuration: { values: { settings: { happyIntegration: true } } } };
    const phoneOf = (user: TeamUser) =>
        new HappyConnection(
            config as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            userInput,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            tasks as never,
            {} as never,
            team as never,
            user,
        );
    const { input, permissionRequest } = nativeToolPermissionQuestion({
        provider: "claude",
        providerTitle: "Claude Code",
        action: "Write notes.txt",
        input: { file_path: "notes.txt" },
        inputDigest: "sha256:" + "a".repeat(64),
    });
    const ask = async () =>
        await userInput.askForPermission(database.context, AGENT, input, permissionRequest);
    const status = async (id: string) => (await userInput.get(database.context, AGENT, id))?.status;
    return { ctx: database.context, userInput, ask, status, phoneOf };
}

describe("a native tool question answered from a team member's phone", () => {
    it("refuses another member's answer and dismissal, and records the owner's answer", async () => {
        const w = await world();
        const asked = await w.ask();
        const allow = { approval: { options: ["Allow once"] } };

        await expect(
            w.phoneOf(MEMBER).answerQuestion(w.ctx, AGENT, asked.id, allow),
        ).rejects.toMatchObject({ name: "HappyMessageRefused" });
        await expect(
            w.phoneOf(MEMBER).cancelQuestion(w.ctx, AGENT, asked.id),
        ).rejects.toMatchObject({ name: "HappyMessageRefused" });
        expect(await w.status(asked.id)).toBe("pending");

        await w.phoneOf(OWNER).answerQuestion(w.ctx, AGENT, asked.id, allow);
        expect(await w.userInput.get(w.ctx, AGENT, asked.id)).toMatchObject({
            status: "answered",
            answeredBy: OWNER.id,
        });
    });

    it("lets the owner dismiss it", async () => {
        const w = await world();
        const asked = await w.ask();
        await w.phoneOf(OWNER).cancelQuestion(w.ctx, AGENT, asked.id);
        expect(await w.status(asked.id)).toBe("cancelled");
    });
});
