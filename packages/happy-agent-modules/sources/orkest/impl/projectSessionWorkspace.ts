import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * GHO-196 — the working copies of a Happy project or doc session.
 *
 * The session's task folder is its workspace, and it holds nothing but `doc/` copies: `docs/<rest>.md` of the
 * project is `<task>/doc/<rest>.md`. The agent edits a copy with its own file tools; `propose_document` reads the
 * copy whole, so the document is never re-emitted by the model (design § 2, the spike's finding). The git blob each
 * copy was made from (its base, the `rev` of `read_doc`) is kept beside the copies in `doc/.orkest-bases.json`, so a
 * worker restart keeps it; a base of `null` marks a new doc the agent is writing.
 */

const BASES = ".orkest-bases.json";
const STALE = ".stale";
const DOC_PATH = /^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;

/** The working copy of a project doc, or a throw for anything that is not a `docs/**.md` path. */
export function workingCopyPath(taskPath: string, docPath: string): string {
    if (!isDocPath(docPath))
        throw new Error(`not a doc path: ${JSON.stringify(docPath).slice(0, 120)}`);
    return join(taskPath, "doc", ...docPath.slice("docs/".length).split("/"));
}

export function isDocPath(docPath: unknown): docPath is string {
    if (typeof docPath !== "string" || docPath.length > 300 || !DOC_PATH.test(docPath))
        return false;
    const parts = docPath.split("/");
    // No dot segments, and nothing that would land on the adapter's own bookkeeping.
    return parts.every((p) => p !== "." && p !== ".." && !p.startsWith(".")) && parts[1] !== STALE;
}

/** Write (or replace) a working copy and remember what it was made from. */
export async function writeWorkingCopy(
    taskPath: string,
    docPath: string,
    text: string,
    rev: string | null,
): Promise<void> {
    const path = workingCopyPath(taskPath, docPath);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, text);
    await setBase(taskPath, docPath, rev);
}

export async function readWorkingCopy(
    taskPath: string,
    docPath: string,
): Promise<string | undefined> {
    try {
        return await readFile(workingCopyPath(taskPath, docPath), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/** The base of a copy: a git blob, `null` for a new doc, `undefined` when the session never made one. */
export async function baseFor(
    taskPath: string,
    docPath: string,
): Promise<string | null | undefined> {
    const bases = await readBases(taskPath);
    return Object.hasOwn(bases, docPath) ? bases[docPath] : undefined;
}

export async function setBase(
    taskPath: string,
    docPath: string,
    rev: string | null,
): Promise<void> {
    workingCopyPath(taskPath, docPath);
    const bases = await readBases(taskPath);
    bases[docPath] = rev;
    await mkdir(join(taskPath, "doc"), { recursive: true });
    await writeAtomic(join(taskPath, "doc", BASES), `${JSON.stringify(bases, null, 2)}\n`);
}

/**
 * The doc moved since the copy was made (`stale_base`): keep the agent's copy as `doc/.stale/<rest>`, and replace
 * the copy with the current text at its new rev, so the agent re-applies its change on what is there now.
 */
export async function refreshStale(
    taskPath: string,
    docPath: string,
    rev: string,
    text: string,
): Promise<void> {
    const path = workingCopyPath(taskPath, docPath);
    const kept = join(taskPath, "doc", STALE, ...docPath.slice("docs/".length).split("/"));
    await mkdir(dirname(kept), { recursive: true });
    try {
        await copyFile(path, kept);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeWorkingCopy(taskPath, docPath, text, rev);
}

async function readBases(taskPath: string): Promise<Record<string, string | null>> {
    try {
        const parsed = JSON.parse(await readFile(join(taskPath, "doc", BASES), "utf8")) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(parsed))
            if (isDocPath(key) && (value === null || typeof value === "string")) out[key] = value;
        return out;
    } catch {
        return {};
    }
}

async function writeAtomic(path: string, text: string): Promise<void> {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
}
