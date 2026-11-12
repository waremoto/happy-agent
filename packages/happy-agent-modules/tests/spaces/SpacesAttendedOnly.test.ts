import { expect, it } from "vitest";
import type { AgentSystemRef } from "@slopus/happy-agent-base";

import { SpacesModule, spaceMigrations } from "../../sources/spaces/index.js";
import { writeOwnerState } from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const OWNER = "standalone";
const PRIORITIZING = "agentprioaaaaaaaaaaaaaaa";

type Params = ConstructorParameters<typeof SpacesModule>;

/**
 * Spaces with every collaborator stubbed except its own database. `invoked` lists every message
 * the module queued for Prioritizing: each one starts a turn of an agent.
 */
async function setup(attendedOnly: boolean) {
    const database = moduleDatabase(spaceMigrations, "spaces-attended-only");
    await database.ready;
    const invoked: { arguments: { text: string } }[] = [];
    const spaces = new SpacesModule(
        {
            attendedOnly,
            configuration: { values: { feature: { team: { enabled: false } } } },
        } as unknown as Params[0],
        {} as Params[1],
        { chiefOfStaff: async () => undefined } as unknown as Params[2],
        {} as Params[3],
        {} as Params[4],
        {} as Params[5],
        {
            register: () => undefined,
            invoke: async (_ctx: unknown, call: { arguments: { text: string } }) => {
                invoked.push(call);
            },
        } as unknown as Params[6],
        {} as Params[7],
        { enabled: false } as unknown as Params[8],
        { get: async () => ({ value: true }) } as unknown as Params[9],
        {} as Params[10],
    );
    spaces.beforeStart(database.context, {
        config: async (_ctx: unknown, id: string) => ({ id, metadata: {} }),
        parentOf: async () => null,
    } as unknown as AgentSystemRef);
    await writeOwnerState(database.context, {
        ownerUserId: OWNER,
        sidebarArtifactId: "artifactaaaaaaaaaaaaaaaa",
        prioritizingAgentId: PRIORITIZING,
    });
    return { database, spaces, invoked };
}

it("control: an ordinary installation queues a tidy request for Prioritizing", async () => {
    const h = await setup(false);
    try {
        expect(await h.spaces.requestTidy(h.database.context, OWNER)).toBe(true);
        expect(h.invoked.map((call) => call.arguments.text)).toEqual([
            expect.stringContaining("Tidy the sidebar now."),
        ]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("never briefs Prioritizing on an attended-only installation, so it works only when a person messages it", async () => {
    const h = await setup(true);
    try {
        await h.spaces.requestTidy(h.database.context, OWNER);
        expect(h.invoked).toEqual([]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});
