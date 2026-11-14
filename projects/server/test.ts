import { describe, test, expect, mock } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

import * as processModule from "./process";
import { isAlive, killOrphan } from "./process";
import { Status, type ProcessInfo } from "../types";

describe("killOrphan", () => {
    test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
        // Spawned detached (own process group, like Process does) and traps
        // SIGTERM so only the SIGKILL escalation path can bring it down.
        const child = Bun.spawn({
            cmd: ["bash", "-c", "trap '' TERM; sleep 30"],
            detached: true,
        });
        const pid = child.pid;
        await Bun.sleep(200); // give the trap a moment to install

        try {
            const reclaimed = await killOrphan(pid);

            expect(reclaimed).toBe(true);
            expect(isAlive(pid)).toBe(false);
        } finally {
            if (isAlive(pid)) {
                try {
                    process.kill(-pid, "SIGKILL");
                } catch {
                    // Already gone
                }
            }
        }
    }, 10_000);

    test("returns true immediately for an already-dead pid", async () => {
        const child = Bun.spawn({ cmd: ["true"], detached: true });
        await child.exited;

        expect(await killOrphan(child.pid)).toBe(true);
    });
});

describe("respawn", () => {
    test("refuses to double-spawn when the old pid can't be reclaimed", async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-test-"));
        const originalCwd = process.cwd();
        process.chdir(tmpDir);

        try {
            const staleEntry: Partial<ProcessInfo> = {
                id: 1,
                startOptions: { name: "orphan", cwd: tmpDir, script: "." },
                logFiles: [],
                pid: process.pid,
            };
            await fs.writeFile(
                path.join(tmpDir, "processes.json"),
                JSON.stringify([staleEntry]),
            );

            // killOrphan is exercised directly above; here we stub it so respawn()'s
            // "still alive after SIGKILL" branch is deterministic instead of depending
            // on a real, unkillable process.
            mock.module("./process", () => ({
                ...processModule,
                killOrphan: async () => false,
            }));

            const manager = (await import("./manager")).default;
            await manager.respawn();

            const orphan = (await manager.list()).find(p => p.id === 1);

            expect(orphan?.status).toBe(Status.Error);
            expect(orphan?.lastError).toContain("could not reclaim pid");
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe("Process lifecycle", () => {
    test("can start again after stop() kills the child with a signal", async () => {
        // A child killed by SIGTERM ends with exitCode null and only signalCode set.
        // start() must treat that as exited, not as still running.
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-test-"));
        await fs.writeFile(path.join(tmpDir, "run.sh"), "sleep 30\n");

        const p = new processModule.Process(
            { name: "sig-restart", cwd: tmpDir, script: "run.sh", interpreter: "bash" },
            999,
        );

        try {
            await p.start();
            const firstPid = p.pid;
            expect(p.status).toBe(Status.Online);

            await p.stop();
            expect(p.status).toBe(Status.Stopped);

            await p.start();
            expect(p.status).toBe(Status.Online);
            expect(p.pid).not.toBe(firstPid);
            expect(isAlive(p.pid!)).toBe(true);

            await p.restart();
            expect(p.status).toBe(Status.Online);
        } finally {
            await p.remove();
        }
    }, 15_000);
});

describe("deployProcess", () => {
    const sh = async (cwd: string, cmd: string) => {
        const p = Bun.spawn({ cmd: ["sh", "-c", cmd], cwd, stdout: "pipe", stderr: "pipe" });
        if (await p.exited !== 0) throw new Error(`${cmd} failed: ${await new Response(p.stderr).text()}`);
        return (await new Response(p.stdout).text()).trim();
    };
    const commit = (repo: string, file: string, content: string) =>
        sh(repo, `printf '%s' '${content}' > ${file} && git add -A && git -c user.name=t -c user.email=t@t commit -qm '${file}' && git rev-parse HEAD`);

    test("clones, skips when up to date, updates, and rolls back a failed build", async () => {
        const { deployProcess } = await import("./deploy");
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-deploy-"));
        const origin = path.join(tmp, "origin");
        const cwd = path.join(tmp, "apps", "app");
        await fs.mkdir(origin);
        await sh(origin, "git init -q -b main");
        const first = await commit(origin, "build.sh", "echo ok > built.txt");

        const proc = new processModule.Process({
            name: "deploy-test",
            cwd,
            git: { repo: origin, branch: "main" },
            build: ["sh build.sh"],
        }, 99);

        // Missing cwd: clone + build
        let r = await deployProcess(proc);
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(true);
        expect(r.commit).toBe(first);
        expect(await Bun.file(path.join(cwd, "built.txt")).text()).toBe("ok\n");
        expect(proc.commit).toBe(first);

        // No new commits: nothing to do
        r = await deployProcess(proc);
        expect(r.ok).toBe(true);
        expect(r.changed).toBe(false);

        // New commit: fetch + reset + build. Untracked files survive.
        await Bun.write(path.join(cwd, ".env"), "SECRET=1");
        const second = await commit(origin, "build.sh", "echo v2 > built.txt");
        r = await deployProcess(proc);
        expect(r.ok).toBe(true);
        expect(r.previousCommit).toBe(first);
        expect(r.commit).toBe(second);
        expect(await Bun.file(path.join(cwd, "built.txt")).text()).toBe("v2\n");
        expect(await Bun.file(path.join(cwd, ".env")).text()).toBe("SECRET=1");

        // Broken build: rolled back to the previous commit and rebuilt
        await commit(origin, "build.sh", "exit 3");
        r = await deployProcess(proc);
        expect(r.ok).toBe(false);
        expect(r.rolledBack).toBe(true);
        expect(r.error).toContain("exit 3");
        expect(r.commit).toBe(second);
        expect(await sh(cwd, "git rev-parse HEAD")).toBe(second);
        expect(await Bun.file(path.join(cwd, "built.txt")).text()).toBe("v2\n");
        expect(proc.lastDeploy?.ok).toBe(false);
        expect(proc.deploying).toBe(false);
    }, 30_000);

    test("refuses a non-empty, non-git cwd and redacts credentials", async () => {
        const { deployProcess, redactUrl } = await import("./deploy");
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-deploy-"));
        await Bun.write(path.join(tmp, "keep.txt"), "x");
        const proc = new processModule.Process({ name: "x", cwd: tmp, git: { repo: "https://u:secret@example.invalid/r.git" } }, 98);
        const r = await deployProcess(proc);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("not a git repository");
        expect(redactUrl("https://u:secret@host/r.git")).toBe("https://***@host/r.git");
    });
});

describe("deployProcess git inference", () => {
    const sh = async (cwd: string, cmd: string) => {
        const p = Bun.spawn({ cmd: ["sh", "-c", cmd], cwd, stdout: "pipe", stderr: "pipe" });
        if (await p.exited !== 0) throw new Error(`${cmd} failed: ${await new Response(p.stderr).text()}`);
        return (await new Response(p.stdout).text()).trim();
    };

    test("adopts origin + branch from an existing checkout, refusing a dirty one", async () => {
        const { deployProcess } = await import("./deploy");
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-infer-"));
        const origin = path.join(tmp, "origin");
        const cwd = path.join(tmp, "app");
        await fs.mkdir(origin);
        await sh(origin, "git init -q -b prod && echo v1 > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm v1");
        await sh(tmp, `git clone -q ${origin} app`);

        const proc = new processModule.Process({ name: "infer", cwd }, 97);

        // Without inferGit (i.e. "deploy all"), an unconfigured process is left alone
        let r = await deployProcess(proc);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("no git repo configured");

        // Tracked local edits block adoption...
        await Bun.write(path.join(cwd, "a.txt"), "local edit\n");
        r = await deployProcess(proc, { inferGit: true });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("uncommitted changes");
        expect(proc.info.git).toBeUndefined();
        expect(await Bun.file(path.join(cwd, "a.txt")).text()).toBe("local edit\n");

        // ...unless forced
        r = await deployProcess(proc, { inferGit: true, force: true });
        expect(r.ok).toBe(true);
        expect(r.inferredGit).toEqual({ repo: origin, branch: "prod" });
        expect(proc.info.git).toEqual({ repo: origin, branch: "prod" });
        expect(await Bun.file(path.join(cwd, "a.txt")).text()).toBe("v1\n");

        // Not a checkout at all
        const plain = await fs.mkdtemp(path.join(os.tmpdir(), "pdd-infer-"));
        await Bun.write(path.join(plain, "x"), "x");
        r = await deployProcess(new processModule.Process({ name: "plain", cwd: plain }, 96), { inferGit: true });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("not a git checkout");
    }, 30_000);
});
