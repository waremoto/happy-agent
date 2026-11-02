// A stand-in for `codex app-server` whose one action needs approval. A prompt containing "touch"
// asks to run `touch outside.txt`; only an accepted request creates outside.txt in the thread's
// folder. Each turn's approval policy is appended to the file named by APPROVAL_LOG.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const say = (delta) =>
    send({
        method: "item/agentMessage/delta",
        params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta },
    });
const completed = () =>
    send({
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn1", status: "completed", error: null } },
    });
let cwd = process.cwd();
let waiting = false;
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === undefined) {
        if (message.id !== "approve-1" || !waiting) return;
        waiting = false;
        const accepted = message.result?.decision === "accept";
        if (accepted) writeFileSync(join(cwd, "outside.txt"), "ran");
        say(accepted ? "ran" : "declined");
        completed();
        return;
    }
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "thread/start":
            cwd = message.params.cwd;
            return reply({ thread: { id: "t1" }, model: "m", reasoningEffort: null });
        case "model/list":
            return reply({ data: [], nextCursor: null });
        case "turn/start": {
            const text = message.params.input.map((item) => item.text ?? "").join("");
            appendFileSync(process.env.APPROVAL_LOG, `${message.params.approvalPolicy}\n`);
            reply({ turn: { id: "turn1" } });
            if (!text.includes("touch")) {
                say("nothing to do");
                completed();
                return;
            }
            waiting = true;
            send({
                id: "approve-1",
                method: "item/commandExecution/requestApproval",
                params: {
                    threadId: "t1",
                    turnId: "turn1",
                    itemId: "cmd-1",
                    command: "touch outside.txt",
                    cwd,
                    reason: "Needs to write outside the sandbox",
                },
            });
            return;
        }
        default:
            return reply({});
    }
});
