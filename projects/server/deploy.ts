import fs from "fs/promises";
import path from "path";
import type { Process } from "./process";
import type { DeployResult } from "../types";

// A hung `bun install` or a git fetch waiting on a dead remote must not hold the
// deploy lock forever.
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
// Only the tail is kept: the response (and memory) shouldn't grow with a noisy build.
const MAX_OUTPUT = 256 * 1024;

// Hides credentials embedded in a clone URL (https://user:token@host/...) from
// output and error messages.
export function redactUrl(text: string): string {
    return text.replace(/(\/\/)[^/@\s]+@/g, "$1***@");
}

class Output {
    text = "";
    append(s: string) {
        this.text += s;
        if (this.text.length > MAX_OUTPUT) this.text = this.text.slice(-MAX_OUTPUT);
    }
}

interface RunResult {
    code: number;
    stdout: string;
    timedOut: boolean;
}

async function run(proc: Process, out: Output, cmd: string[], cwd: string, display: string): Promise<RunResult> {
    const emit = (type: "out" | "err", line: string) => {
        out.append(line);
        // Same event the app's own output uses, so `pd logs -f` / the SSE stream
        // show a deploy live.
        proc.emit("out", { type, line });
    };
    emit("out", `[deploy] $ ${redactUrl(display)}\n`);

    const child = Bun.spawn({
        cmd,
        cwd,
        env: {
            ...process.env,
            ...proc.info.env,
            // Never block on an interactive credential / host-key prompt; there's no TTY.
            GIT_TERMINAL_PROMPT: "0",
            GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Own process group, so the timeout kill also takes out anything the
        // build command forked (e.g. a package manager's child processes).
        detached: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, COMMAND_TIMEOUT_MS);

    let stdout = "";
    const pump = async (stream: ReadableStream<Uint8Array>, type: "out" | "err") => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
            const s = decoder.decode(chunk, { stream: true });
            if (type === "out" && stdout.length < 4096) stdout += s;
            emit(type, s);
        }
    };
    await Promise.all([pump(child.stdout, "out"), pump(child.stderr, "err")]);
    const code = await child.exited;
    clearTimeout(timer);
    if (timedOut) emit("err", `[deploy] timed out after ${COMMAND_TIMEOUT_MS / 60000}m, killed\n`);
    return { code, stdout, timedOut };
}

async function dirState(dir: string): Promise<"missing" | "empty" | "repo" | "other"> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return "missing";
    }
    if (entries.length === 0) return "empty";
    return entries.includes(".git") ? "repo" : "other";
}

class DeployError extends Error {}

// Brings proc's cwd to the tip of its configured branch and runs its build
// commands. Never touches the running process itself: the caller decides whether
// to restart based on the result. On a build failure the checkout is reset back to
// the previous commit (and rebuilt) so a later crash-restart doesn't pick up
// half-built new code.
//
// With `inferGit`, a process that has no git config but whose cwd is already a
// checkout adopts that checkout's origin URL + current branch. Since every deploy
// is a `reset --hard`, adoption refuses a checkout with uncommitted changes to
// tracked files unless `force` is set; the caller only passes `inferGit` for an
// explicitly named process, never for "all".
export async function deployProcess(proc: Process, opts: { force?: boolean; inferGit?: boolean } = {}): Promise<DeployResult> {
    const result: DeployResult = { id: proc.id, ok: false, changed: false, output: "" };
    let git = proc.info.git;
    if (!git?.repo && !opts.inferGit) {
        result.error = "no git repo configured for this process";
        return result;
    }
    if (proc.deploying) {
        result.error = "a deploy is already in progress for this process";
        return result;
    }
    proc.deploying = true;

    const out = new Output();
    const cwd = proc.info.cwd;

    const runIn = (dir: string, cmd: string[], display = cmd.join(" ")) => run(proc, out, cmd, dir, display);
    const gitOk = async (args: string[], what: string): Promise<string> => {
        const r = await runIn(cwd, ["git", ...args]);
        if (r.code !== 0) throw new DeployError(`${what} failed (exit ${r.code})`);
        return r.stdout.trim();
    };
    const runBuild = async (): Promise<string | undefined> => {
        for (const cmd of proc.info.build ?? []) {
            const r = await runIn(cwd, ["sh", "-c", cmd], cmd);
            if (r.code !== 0) return `build command failed (${r.timedOut ? "timed out" : `exit ${r.code}`}): ${cmd}`;
        }
    };

    try {
        const state = await dirState(cwd);
        let previous: string | undefined;

        if (!git?.repo) {
            if (state !== "repo") {
                throw new DeployError(`no git repo configured, and ${cwd} is not a git checkout to read one from (set one with --git or POST /config)`);
            }
            const repo = await gitOk(["remote", "get-url", "origin"], "reading the checkout's origin (git remote get-url origin)");
            const current = await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], "reading the checkout's branch");
            if (!repo) throw new DeployError("the checkout's origin remote has no URL");
            if (current === "HEAD") {
                throw new DeployError("the checkout is on a detached HEAD, so there's no branch to follow; set git.branch explicitly");
            }
            const dirty = await gitOk(["status", "--porcelain", "--untracked-files=no"], "git status");
            if (dirty && !opts.force) {
                throw new DeployError("the checkout has uncommitted changes to tracked files, which deploying (git reset --hard) would discard; commit or stash them, or deploy with --force");
            }
            git = { repo, branch: current };
            result.inferredGit = git;
            out.append(`[deploy] no git config, using the checkout's origin ${redactUrl(repo)} on branch ${current}\n`);
        }
        const branch = git.branch || "main";

        if (state === "missing" || state === "empty") {
            const parent = path.dirname(cwd);
            await fs.mkdir(parent, { recursive: true });
            const r = await runIn(parent, ["git", "clone", "--branch", branch, "--single-branch", git.repo, cwd]);
            if (r.code !== 0) throw new DeployError(`git clone failed (exit ${r.code})`);
        } else if (state === "other") {
            throw new DeployError(`cwd ${cwd} exists, is not empty, and is not a git repository`);
        } else {
            previous = await gitOk(["rev-parse", "HEAD"], "git rev-parse");
            // Keep origin in sync with the configured repo, in case it changed.
            const setUrl = await runIn(cwd, ["git", "remote", "set-url", "origin", git.repo]);
            if (setUrl.code !== 0) await gitOk(["remote", "add", "origin", git.repo], "git remote add");
            await gitOk(["fetch", "origin", branch], "git fetch");
            const target = await gitOk(["rev-parse", "FETCH_HEAD"], "git rev-parse");
            if (target === previous && !opts.force) {
                out.append(`[deploy] already at ${previous.slice(0, 7)}, nothing to do\n`);
                result.ok = true;
                result.commit = previous;
                result.previousCommit = previous;
                return result;
            }
            // reset --hard, not pull: a node mirrors the branch, so local edits or a
            // force-pushed branch must never wedge a deploy on a merge conflict.
            // Untracked files (.env, sqlite dbs, uploads) are left alone.
            await gitOk(["reset", "--hard", "FETCH_HEAD"], "git reset");
        }

        const commit = await gitOk(["rev-parse", "HEAD"], "git rev-parse");
        result.commit = commit;
        result.previousCommit = previous;

        const buildError = await runBuild();
        if (buildError) {
            result.error = buildError;
            if (previous) {
                out.append(`[deploy] rolling back to ${previous.slice(0, 7)}\n`);
                await gitOk(["reset", "--hard", previous], "rollback git reset");
                const rebuildError = await runBuild();
                result.rolledBack = true;
                result.commit = previous;
                if (rebuildError) result.error += `; rollback rebuild also failed: ${rebuildError}`;
            }
            return result;
        }

        result.ok = true;
        result.changed = commit !== previous || !!opts.force;
        // Adopted only once the whole deploy worked, so a failed first attempt
        // doesn't leave the process half-converted to git-backed.
        if (result.inferredGit) proc.info.git = result.inferredGit;
        return result;
    } catch (err) {
        const msg = err instanceof DeployError ? err.message : `deploy failed: ${err}`;
        // Keep the original build error if the rollback itself is what threw.
        result.error = result.error ? `${result.error}; ${msg}` : msg;
        return result;
    } finally {
        proc.deploying = false;
        if (result.error) {
            result.error = redactUrl(result.error);
            out.append(`[deploy] failed: ${result.error}\n`);
        }
        result.output = redactUrl(out.text);
        if (result.commit) proc.commit = result.commit;
        proc.lastDeploy = {
            at: new Date().toISOString(),
            ok: result.ok,
            ...(result.commit && { commit: result.commit }),
            ...(result.error && { error: result.error }),
        };
    }
}
