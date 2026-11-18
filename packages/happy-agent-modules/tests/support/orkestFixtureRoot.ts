import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
    interface ProvidedContext {
        orkestFixtureRoot: string;
    }
}

// Windows can keep native SQLite handles open for the worker's lifetime. Let the
// runner remove its own temporary root after the test workers have exited.
export default async function setup(project: TestProject) {
    const root = await mkdtemp(join(tmpdir(), "happy-orkest-suite-"));
    project.provide("orkestFixtureRoot", root);
    return async () => rm(root, { recursive: true, force: true, maxRetries: 3 });
}
