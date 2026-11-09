import pidusage from "pidusage";

import { Status, type ProcessOptions, type ProcessOptionsConfirmed, type Stat } from "../types.ts";
import path from "path";
import fs from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import { EventEmitter } from "events";

export const logDir = path.join(process.cwd(), "logs");
await fs.mkdir(logDir, { recursive: true });

async function checkExists(p: string) {
    try {
        await fs.access(p);
        return true;
    } catch {
        // Does not exist
    }
    return false;
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means it exists but we can't signal it; still alive.
        return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
}

// Sends the whole process group a SIGTERM (mirroring Process.stop()) and waits
// briefly for it to die, escalating to SIGKILL if it ignores the SIGTERM. Used
// on respawn to clean up a child left running from before a daemon crash, so
// we don't spawn a duplicate on top of it. Returns whether the pid is actually
// dead by the end, so callers can refuse to double-spawn if it isn't.
export async function killOrphan(pid: number): Promise<boolean> {
    if (!isAlive(pid)) return true;
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        // Group already gone, or we lack permission to signal it.
    }
    for (let i = 0; i < 10 && isAlive(pid); i++) {
        await Bun.sleep(200);
    }
    if (!isAlive(pid)) return true;

    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // Group already gone, or we lack permission to signal it.
    }
    for (let i = 0; i < 10 && isAlive(pid); i++) {
        await Bun.sleep(200);
    }
    return !isAlive(pid);
}

function resolveInterpreter(name: string): string | null {
    const found = Bun.which(name);
    if (found) return found;

    const candidates = [
        process.env.HOME ? `${process.env.HOME}/.bun/bin/${name}` : null,
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
    ].filter(Boolean) as string[];

    return candidates.find(existsSync) ?? null;
}

export class Process extends EventEmitter {
    public info: ProcessOptionsConfirmed;
    public id: number;
    private spawned?: Bun.Subprocess;

    // Captured straight from Bun.spawn(), independent of `monit` (which is only
    // populated once pidusage successfully runs). Lets manager.save() persist the
    // real pid even before the first resource-usage poll completes.
    public pid?: number;

    public lastExit?: number;
    public lastCode?: number | null;
    public lastError?: string;

    // All log file base names for this process, oldest first.
    // Each entry maps to <base>.out.log and <base>.err.log in logDir.
    public logFiles: string[];
    private fileInc: number;

    public removed: boolean = false;
    public status: Status = Status.Stopped;
    public restartCount: number = 0;

    private _stopping = false;
    // Set synchronously at the top of start(), before any await, so a second
    // call landing during the preflight checks below (interpreter/cwd/script)
    // can't slip past the this.spawned guard, which isn't set until after those
    // awaits resolve. Without this, a manual start/restart racing a pending
    // auto-restart setTimeout could both pass the guard and double-spawn.
    private _starting = false;
    private stableTimer?: ReturnType<typeof setTimeout>;

    public monit?: Stat;

    constructor(info: ProcessOptions, id: number, initialLogFiles: string[] = []) {
        super();
        this.id = id;
        this.logFiles = [...initialLogFiles];
        // fileInc ensures unique filenames even after old entries are pruned from logFiles
        this.fileInc = initialLogFiles.length;
        if (!info?.script?.trim()) info.script = ".";
        info.interpreter ||= "bun";
        this.info = { ...info, script: info.script!, interpreter: info.interpreter! };
    }

    private newLogBase(): string {
        const base = `${this.info.name.replaceAll("/", "_")}-${Bun.randomUUIDv7().split("-").pop()}-${this.fileInc++}`;
        this.logFiles.push(base);
        return base;
    }

    // Returns combined stdout/stderr content across the last `runs` runs (all runs if omitted).
    // Each run's content is bracketed by start/end marker lines written at spawn time.
    async readLogFiles(runs?: number): Promise<{ out: string; err: string }> {
        if (this.logFiles.length === 0) return { out: "", err: "" };
        const toRead = runs !== undefined ? this.logFiles.slice(-runs) : this.logFiles;
        let out = "", err = "";
        for (const base of toRead) {
            const outFile = Bun.file(path.join(logDir, `${base}.out.log`));
            const errFile = Bun.file(path.join(logDir, `${base}.err.log`));
            if (await outFile.exists()) out += await outFile.text();
            if (await errFile.exists()) err += await errFile.text();
        }
        return { out, err };
    }

    // Deletes log file pairs for all runs beyond the most recent `keep`.
    async cleanOldLogs(keep = 10): Promise<void> {
        if (this.logFiles.length <= keep) return;
        const toDelete = this.logFiles.splice(0, this.logFiles.length - keep);
        for (const base of toDelete) {
            await fs.unlink(path.join(logDir, `${base}.out.log`)).catch(() => {});
            await fs.unlink(path.join(logDir, `${base}.err.log`)).catch(() => {});
        }
    }

    async start(isAutoRestart = false) {
        if (this.removed) return;
        if (isAutoRestart && this._stopping) return;
        // this.spawned.exited is a Promise, always truthy, so checking it directly
        // never detects a still-running child; exitCode is null until it exits.
        if (this.spawned && this.spawned.exitCode === null) return;
        if (this._starting) return;
        this._starting = true;
        if (!isAutoRestart) {
            this.restartCount = 0;
            this._stopping = false;
        }
        const that = this;

        this.status = Status.Starting;

        const interpreterPath = resolveInterpreter(this.info.interpreter);
        if (!interpreterPath) {
            this.lastError = "No interpreter";
            this.status = Status.Error;
            this._starting = false;
            return;
        }

        if (!await checkExists(this.info.cwd)) {
            this.lastError = "No CWD Exists";
            this.status = Status.Error;
            this._starting = false;
            return;
        }

        if (this.info.script != ".") {
            const scriptPath = path.join(this.info.cwd, this.info.script);
            if (!await Bun.file(scriptPath).exists()) {
                this.lastError = "No Script Exists";
                this.status = Status.Error;
                this._starting = false;
                return;
            }
        }

        const base = this.newLogBase();
        const outPath = path.join(logDir, `${base}.out.log`);
        const errPath = path.join(logDir, `${base}.err.log`);

        const startTs = new Date().toISOString();
        const startMarker = `-- Process (${this.id}) started at ${startTs} --\n`;
        await fs.writeFile(outPath, startMarker);
        await fs.writeFile(errPath, startMarker);

        const outStream = createWriteStream(outPath, { flags: "a" });
        const errStream = createWriteStream(errPath, { flags: "a" });
        // Without a listener, a write failure (e.g. ENOSPC) throws as an uncaught
        // exception instead of being attributed to this process.
        outStream.on("error", err => console.error(`[pdd] log write failed for process ${that.id}:`, err));
        errStream.on("error", err => console.error(`[pdd] log write failed for process ${that.id}:`, err));

        const proc = Bun.spawn({
            cmd: [interpreterPath, this.info.script],
            env: { ...process.env, ...this.info.env },
            cwd: this.info.cwd,
            stdout: "pipe",
            stderr: "pipe",
            detached: true,

            onExit(_subprocess, exitCode, _signalCode, error) {
                if (that.stableTimer) clearTimeout(that.stableTimer);
                that.lastExit = new Date().valueOf();
                that.lastCode = exitCode;

                if (error || exitCode !== 0) {
                    that.status = Status.Error;
                } else {
                    that.status = Status.Stopped;
                }

                if (that.info.restart && !that._stopping) {
                    that.spawned = undefined;
                    that.restartCount += 1;
                    const maxRestarts = that.info.maxRestarts ?? 5;
                    if (that.restartCount >= maxRestarts) {
                        that.status = Status.Error;
                        that.lastError = `Exceeded max restarts (${maxRestarts})`;
                        return;
                    }
                    setTimeout(() => that.start(true), 5 * 1000);
                }
            },
        });

        this.status = Status.Online;
        this.lastError = undefined;
        this.spawned = proc;
        this.pid = proc.pid;
        this._starting = false;

        // Notify manager (or any other listener) that a new child is live so it can
        // persist the fresh pid, including on the internal auto-restart path below
        // which never goes through an HTTP route.
        this.emit("spawned");

        // Consider the restart storm over once the process has stayed up for a while,
        // so a crash long after a healthy run doesn't inherit the old restart count.
        this.stableTimer = setTimeout(() => {
            that.restartCount = 0;
        }, 30 * 1000);

        const outDone = (async () => {
            for await (const chunk of proc.stdout) {
                outStream.write(chunk);
                that.emit("out", {
                    type: "out",
                    line: new TextDecoder().decode(chunk)
                });
            }
        })();

        const errDone = (async () => {
            for await (const chunk of proc.stderr) {
                errStream.write(chunk);
                that.emit("out", {
                    type: "err",
                    line: new TextDecoder().decode(chunk)
                });
            }
        })();

        // After the process exits and both streams are fully drained, write the end marker
        // and clean up old log files beyond the retention limit.
        Promise.all([outDone, errDone]).then(async () => {
            const ts = new Date().toISOString();
            const code = that.lastCode;
            let verb: string;
            if (that._stopping) verb = "stopped";
            else if (code === 0) verb = "exited";
            else verb = `errored (code ${code ?? "unknown"})`;

            const endMarker = `-- Process (${that.id}) ${verb} at ${ts} --\n`;
            await new Promise<void>(r => outStream.write(endMarker, () => outStream.end(r)));
            await new Promise<void>(r => errStream.write(endMarker, () => errStream.end(r)));

            await that.cleanOldLogs();
        });
    }

    async getResourceUsage(): Promise<Stat | undefined> {
        if (!this.spawned || this.spawned.exitCode !== null) return;
        try {
            this.monit = await pidusage(this.spawned.pid) as Stat;
        } catch {
            // Process exited between the exitCode check and pidusage call
        }
        return this.monit;
    }

    async stop() {
        if (this.removed) return;

        this.status = Status.Stopping;

        this._stopping = true;
        if (this.spawned) {
            const spawned = this.spawned;
            // The child is spawned detached (its own process group), so a plain
            // spawned.kill() only signals it, not any subprocess it forked internally
            // (e.g. "npm start" wrapping a real server). Signal the whole group instead
            // by targeting the negative pid, so wrapper-spawned children die with it.
            // Note: a script that further detaches its own grandchild (setsid again)
            // escapes this group and won't be caught here; known limitation, out of scope.
            try {
                process.kill(-spawned.pid, "SIGTERM");
            } catch {
                // Group already gone
            }

            const exitedInTime = await Promise.race([
                spawned.exited.then(() => true),
                Bun.sleep(5000).then(() => false),
            ]);

            // SIGTERM went unhandled (or was ignored): escalate so stop() never hangs
            // indefinitely on an unresponsive child.
            if (!exitedInTime && isAlive(spawned.pid)) {
                try {
                    process.kill(-spawned.pid, "SIGKILL");
                } catch {
                    // Group already gone
                }
                await Promise.race([spawned.exited, Bun.sleep(2000)]);
            }
        }

        this.status = Status.Stopped;
    }

    async restart() {
        if (this.removed) return;

        await this.stop();

        await this.start();
    }

    // Updates the env vars used on the *next* spawn. Doesn't touch a currently
    // running process; callers that want the change applied immediately restart it.
    setEnv(env: Record<string, string>, replace = false) {
        this.info.env = replace ? { ...env } : { ...this.info.env, ...env };
    }

    async remove() {
        if (this.removed) return;
        await this.stop();
        this.spawned = undefined;
        this.removed = true;
    }
}
