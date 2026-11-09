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
