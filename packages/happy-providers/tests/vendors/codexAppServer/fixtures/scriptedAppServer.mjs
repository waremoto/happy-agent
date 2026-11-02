// A stand-in for `codex app-server`: answers the driver's requests and, for each turn, sends an
// agent message delta followed immediately by turn/completed with the status the prompt names. A
// prompt containing "ask" first asks approval for one command and reports the decision it got and
// the turn's approval policy as its message.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const completed = (text) =>
    send({
        method: "turn/completed",
        params: {
            threadId: "t1",
            turn: {
                id: "turn1",
                status: text.includes("fail") ? "failed" : "completed",
                error: text.includes("fail")
                    ? { message: "exceeded retry limit, last status: 429" }
                    : null,
            },
        },
    });
let approval;
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === undefined) {
        // The driver's answer to our approval request.
        if (message.id === "approve-1" && approval !== undefined) {
            send({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "t1",
                    turnId: "turn1",
                    itemId: "i1",
                    delta: `decision:${message.result?.decision}|policy:${approval.policy}`,
                },
            });
            completed("");
            approval = undefined;
        }
        return;
    }
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            return reply({});
        case "thread/start":
            return reply({ thread: { id: "t1" }, model: "m", reasoningEffort: null });
        case "model/list":
            return reply({ data: [], nextCursor: null });
        case "turn/start": {
            const text = message.params.input.map((item) => item.text ?? "").join("");
            reply({ turn: { id: "turn1" } });
            if (text.includes("ask")) {
                approval = { policy: message.params.approvalPolicy };
                send({
                    id: "approve-1",
                    method: "item/commandExecution/requestApproval",
                    params: {
                        threadId: "t1",
                        turnId: "turn1",
                        itemId: "cmd-1",
                        command: "touch outside.txt",
                        cwd: "/workspace",
                        reason: "Needs to write outside the sandbox",
                    },
                });
                return;
            }
            send({
                method: "item/agentMessage/delta",
                params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta: "partial" },
            });
            completed(text);
            return;
        }
        default:
            return reply({});
    }
});
