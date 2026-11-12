import { describe, expect, it, vi } from "vitest";

import type { AgentSystemRef } from "@slopus/happy-agent-base";

import { onboardingMigrations } from "../../sources/onboarding/OnboardingMigrations.js";
import { OnboardingModule } from "../../sources/onboarding/OnboardingModule.js";
import { upsertOnboardingState } from "../../sources/onboarding/persistence/upsertOnboardingState.js";
import { createUuidV7Factory } from "../../sources/utils/createUuidV7.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

type Params = ConstructorParameters<typeof OnboardingModule>;

/**
 * Onboarding's hidden event reaches Happy's model as a system message that starts Happy's turn.
 * A completed phone pairing while onboarding is guided is one such event.
 */
async function pairingWhileGuided(attendedOnly: boolean): Promise<readonly unknown[]> {
    const database = moduleDatabase(onboardingMigrations, "onboarding-attended-only");
    await database.ready;
    const ctx = database.context;
    const sent: unknown[] = [];
    let onPairing: ((ctx: unknown, event: unknown) => void) | undefined;
    const module = new OnboardingModule(
        { attendedOnly, models: [] } as unknown as Params[0],
        { register: vi.fn() } as unknown as Params[1],
        {} as Params[2],
        { chiefOfStaff: async () => ({ agentId: "happy" }) } as unknown as Params[3],
        { onEvent: vi.fn(), get: async () => ({ name: "Kirill" }) } as unknown as Params[4],
        { onUpdated: vi.fn() } as unknown as Params[5],
        {} as Params[6],
        {} as Params[7],
        {} as Params[8],
        {
            onEvent: (listener: (ctx: unknown, event: unknown) => void) => {
                onPairing = listener;
            },
        } as unknown as Params[9],
    );
    module.beforeStart(ctx, {
        config: async () => ({ metadata: {} }),
        send: async (_ctx: unknown, agentId: string, message: unknown) => {
            sent.push({ agentId, message });
        },
    } as unknown as AgentSystemRef);
    try {
        await upsertOnboardingState(ctx, "standalone", {
            step: "guided",
            completedVersion: null,
            verified: null,
            exampleSidebar: false,
            restartRequired: false,
            connecting: null,
            awaitingSignIn: false,
            connections: [],
            model: { providerId: "claude", modelId: "opus-5" },
            profilePrefill: null,
            findings: null,
            proposal: null,
            started: [],
            placed: false,
            pairingId: "pairing-a",
            phonePaired: false,
            pending: null,
            version: createUuidV7Factory()(),
            updatedAt: 1,
        } as never);
        onPairing!(ctx, {
            mobileConnector: { pairing: { status: "completed", id: "pairing-a", device: null } },
        });
        // The listener runs its work detached; give it time to finish.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return sent;
    } finally {
        database.close();
    }
}

describe("onboarding on an attended-only installation", () => {
    it("control: an ordinary installation tells Happy's model about the paired phone", async () => {
        const sent = await pairingWhileGuided(false);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            agentId: "happy",
            message: { role: "system" },
        });
    });

    it("sends no hidden message to Happy's model", async () => {
        expect(await pairingWhileGuided(true)).toEqual([]);
    });
});
