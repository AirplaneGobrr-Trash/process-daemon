import fs from "fs/promises";
import path from "path";
import type { FileEntry } from "../types";

// File access for remote tools (e.g. auto-deploy's file editor), confined to a
// process's own cwd. Anything that can reach the API can already run arbitrary
// commands through POST /start, so this adds convenience, not privilege; the
// sandbox is about not editing the wrong thing by accident.

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

export class FileError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// Resolves `sub` inside `root`, refusing `..` escapes and symlinks that point
// outside root. For a path that doesn't exist yet (a new file), its parent
// directory is what has to resolve inside root.
async function resolveInside(root: string, sub: string, mustExist: boolean): Promise<string> {
    const realRoot = await fs.realpath(root).catch(() => {
        throw new FileError(404, `process cwd ${root} does not exist`);
    });
    const target = path.resolve(realRoot, sub || ".");
    const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
    if (!inside(target)) throw new FileError(400, "path escapes the process directory");

    let real: string;
    try {
        real = await fs.realpath(target);
    } catch {
        if (mustExist) throw new FileError(404, `no such file or directory: ${sub}`);
        const parent = await fs.realpath(path.dirname(target)).catch(() => {
            throw new FileError(404, `parent directory does not exist: ${path.dirname(sub)}`);
        });
        if (!inside(parent)) throw new FileError(400, "path escapes the process directory");
        return path.join(parent, path.basename(target));
    }
    if (!inside(real)) throw new FileError(400, "path resolves (via a symlink) outside the process directory");
    return real;
}

export async function listDir(root: string, sub: string): Promise<FileEntry[]> {
    const dir = await resolveInside(root, sub, true);
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new FileError(400, "not a directory");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return Promise.all(entries.map(async e => {
        let type: FileEntry["type"] = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
        let size: number | undefined;
        if (e.isSymbolicLink() || e.isFile()) {
            const s = await fs.stat(path.join(dir, e.name)).catch(() => undefined);
            if (s) {
                type = s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
                if (s.isFile()) size = s.size;
            }
        }
        return { name: e.name, type, ...(size !== undefined && { size }) };
    }));
}

export async function readText(root: string, sub: string): Promise<{ content: string; size: number }> {
    const file = await resolveInside(root, sub, true);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new FileError(400, "not a regular file");
    if (stat.size > MAX_READ_BYTES) throw new FileError(413, `file is ${stat.size} bytes; the limit is ${MAX_READ_BYTES}`);
    const buf = await fs.readFile(file);
    if (buf.includes(0)) throw new FileError(415, "file looks binary");
    return { content: buf.toString("utf8"), size: stat.size };
}

// Writes atomically (tmp + rename) so a half-written config never gets read by
// the app, and keeps the existing file's mode.
export async function writeText(root: string, sub: string, content: string): Promise<{ size: number; created: boolean }> {
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new FileError(413, `content is over ${MAX_WRITE_BYTES} bytes`);
    const file = await resolveInside(root, sub, false);
    const existing = await fs.stat(file).catch(() => undefined);
    if (existing && !existing.isFile()) throw new FileError(400, "not a regular file");
    const tmp = `${file}.pdd-tmp-${process.pid}`;
    await fs.writeFile(tmp, content, { mode: existing?.mode ?? 0o644 });
    await fs.rename(tmp, file);
    return { size: Buffer.byteLength(content), created: !existing };
}
