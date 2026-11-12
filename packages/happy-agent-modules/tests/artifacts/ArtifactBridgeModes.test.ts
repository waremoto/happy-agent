import { withAgentContext } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { createArtifactTool } from "../../sources/artifacts/tools/create_artifact.js";
import { editArtifactFileTool } from "../../sources/artifacts/tools/edit_artifact_file.js";
import { listArtifactsTool } from "../../sources/artifacts/tools/list_artifacts.js";
import { updateArtifactTool } from "../../sources/artifacts/tools/update_artifact.js";
import { writeArtifactFileTool } from "../../sources/artifacts/tools/write_artifact_file.js";

const stub = {} as never;
type Refusing = { refusedInModes?: readonly string[] };

describe("artifact tools reached through the Happy bridge", () => {
    it("declare the modes in which Happy refuses them, so a native agent is not asked first", () => {
        const writers = [
            createArtifactTool(stub, stub, "agent-a"),
            updateArtifactTool(stub, stub, "agent-a"),
            writeArtifactFileTool(stub, "agent-a"),
            editArtifactFileTool(stub, "agent-a"),
        ];
        for (const tool of writers) {
            expect((tool as Refusing).refusedInModes, tool.name).toEqual(["read_only"]);
        }
        // A read the mode allows is still put to the person.
        expect((listArtifactsTool(stub, "agent-a") as Refusing).refusedInModes).toBeUndefined();
    });

    it("declares Read only only where the tool really refuses it", async () => {
        const create = createArtifactTool(stub, stub, "agent-a");
        const readOnly = withAgentContext(createRootContext(), {
            id: "agent-a",
            provider: "claude",
            permissionMode: "read_only",
        });
        await expect(
            create.execute(
                readOnly,
                { type: "html", title: "Page", files: [] } as never,
                { kv: { getOrCreate: async () => "id" } } as never,
            ),
        ).rejects.toThrow("Read only mode cannot create artifacts.");
    });
});
