import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// GHO-196.1.1 — the Happy adapter's pinned copy of Hoja (0.5.0, D-17, D-25; 0.5.1 since GHO-200.3.3). The copy is edited in D:/ware/hoja and
// re-vended, never here: every file must match hoja.pin.json and nothing unpinned may sit beside it.
const ROOT = fileURLToPath(new URL("../../sources/orkest/hoja", import.meta.url));

function filesUnder(dir: string, prefix = ""): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`)
            : [`${prefix}${entry.name}`],
    );
}

describe("vended Hoja", () => {
    it("is Hoja 0.5.1 and every file matches its pin", () => {
        const pinPath = join(ROOT, "hoja.pin.json");
        expect(existsSync(pinPath)).toBe(true);
        const pin = JSON.parse(readFileSync(pinPath, "utf8")) as {
            version: string;
            files: Record<string, string>;
        };
        expect(pin.version).toBe("0.5.1");
        expect(Object.keys(pin.files)).toContain("assist/contract.mjs");
        for (const [name, hash] of Object.entries(pin.files)) {
            const actual = createHash("sha256")
                .update(readFileSync(join(ROOT, name)))
                .digest("hex");
            expect(actual, name).toBe(hash);
        }
        const unpinned = filesUnder(ROOT).filter((n) => n !== "hoja.pin.json" && !(n in pin.files));
        expect(unpinned).toEqual([]);
    });

    it("gives the tool-host contract that names propose_document and the working copy", async () => {
        const assist = (await import("../../sources/orkest/hoja/assist/index.mjs")) as {
            documentContract: (options: Record<string, unknown>) => string;
            documentOutline: (body: string) => unknown[];
        };
        const text = assist.documentContract({ host: "tool", workingCopy: "doc/ROADMAP.md" });
        expect(text).toContain("propose_document");
        expect(text).toContain("doc/ROADMAP.md");
        expect(text).not.toContain("propuesta");
        expect(assist.documentOutline("# A\n\ntext\n\n## B\n\nmore\n").length).toBeGreaterThan(0);
    });
});
