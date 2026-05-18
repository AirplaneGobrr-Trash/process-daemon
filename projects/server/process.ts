import pidusage from "pidusage";

import { Status, type ProcessOptions, type ProcessOptionsConfirmed, type Stat } from "../types.ts";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { EventEmitter } from "events";

export const logDir = path.join(process.cwd(), "logs");
await fs.mkdir(logDir, { recursive: true });

async function checkExists(path: string) {
    try {
        await fs.access(path);
        return true;
    } catch {
        // Does not exist
    }
    return false;
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

function formatBytes(bytes: string | number, decimals = 2) {
    bytes = Number(bytes);
    if (!+bytes) return '0 Bytes'

    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']

    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

export class Process extends EventEmitter {
    public info: ProcessOptionsConfirmed;
    private spawned?: Bun.Subprocess;

    public lastExit?: number;
    public lastCode?: number | null;
    public lastError?: string;
    public fileName?: string;
    public fileInc: number = 0;

    public removed: boolean = false;
    public status: Status = Status.Stopped;
    public restartCount: number = 0;

    private _stopping = false;

    public monit?: Stat;

    constructor(info: ProcessOptions) {
        super();
        if (!info?.script?.trim()) info.script = ".";
        info.interpreter ||= "bun";

        this.info = { ...info, script: info.script!, interpreter: info.interpreter! };
    }

    async getLogFile(path: string) {
        const file = Bun.file(path);
        if (!await file.exists()) await Bun.write(file, "");
        return file
    }

    async getLogFiles(newFile: boolean = false) {
        const newF = newFile || !this.fileName
        // If we are making a new file or no file name
        if (newF) this.fileName = `${this.info.name.replaceAll("/", "_")}-${Bun.randomUUIDv7().split("-").pop()}-${this.fileInc++}`

        // We should really cache the results below??
        const outputLogFile = await this.getLogFile(path.join(logDir, `${this.fileName}.out.log`));
        const outputErrLogFile = await this.getLogFile(path.join(logDir, `${this.fileName}.err.log`));

        return {
            outputLogFile,
            outputErrLogFile
        }
    }

    async readLogFiles() {
        if (!this.fileName) return { out: "", err: "" };

        const { outputLogFile, outputErrLogFile } = await this.getLogFiles();
        return {
            out: await outputLogFile.text(),
            err: await outputErrLogFile.text()
        }
    }

    async start(isAutoRestart = false) {
        if (this.removed) return;
        if (isAutoRestart && this._stopping) return;
        if (this.spawned && !this.spawned.exited) return;
        if (!isAutoRestart) {
            this.restartCount = 0;
            this._stopping = false;
        }
        const that = this;

        // TODO: restart lockout
        // Not sure how to do that lols!

        this.status = Status.Starting;

        const interpreterPath = resolveInterpreter(this.info.interpreter);
        if (!interpreterPath) {
            this.lastError = "No interpreter";
            this.status = Status.Error;
            return;
        }

        // Check if CWD exists
        if (!await checkExists(this.info.cwd)) {
            this.lastError = "No CWD Exists";
            this.status = Status.Error;
            return;
        }

        // Check if script exists
        if (this.info.script != ".") {
            const scriptPath = path.join(this.info.cwd, this.info.script);
            if (!await Bun.file(scriptPath).exists()) {
                this.lastError = "No Script Exists";
                this.status = Status.Error;
                return;
            }
        }

        const { outputLogFile, outputErrLogFile } = await this.getLogFiles(true);
        const outWriter = outputLogFile.writer();
        const errWriter = outputErrLogFile.writer();

        const proc = Bun.spawn({
            cmd: [interpreterPath, this.info.script],
            env: { ...process.env, ...this.info.env },
            cwd: this.info.cwd,
            // stdout: outputLogFile,
            // stderr: outputErrLogFile,

            stdout: "pipe",
            stderr: "pipe",

            onExit(subprocess, exitCode, signalCode, error) {
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

        (async () => {
            for await (const chunk of proc.stdout) {
                outWriter.write(chunk);
                that.emit("out", {
                    type: "out",
                    line: new TextDecoder().decode(chunk)
                });
            }
            await outWriter.end();
        })();

        (async () => {
            for await (const chunk of proc.stderr) {
                errWriter.write(chunk);
                that.emit("out", {
                    type: "err",
                    line: new TextDecoder().decode(chunk)
                });
            }
            await errWriter.end();
        })();

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
        this.spawned?.kill();
        await this.spawned?.exited;

        this.status = Status.Stopped;
    }

    async restart() {
        if (this.removed) return;

        await this.stop();

        await this.start();
    }

    async remove() {
        if (this.removed) return;
        await this.stop();
        // Clear properties
        this.spawned = undefined;
        this.removed = true;
    }

}