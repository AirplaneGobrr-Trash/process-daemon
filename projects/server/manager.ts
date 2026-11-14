import fs from "fs/promises";
import { Status, type ProcessOptions, type ProcessInfo, type Getter, type Actions, type ActionResult, type DeployActionResult, type DeployInfo, type DeployResult } from "../types";
import { Process, killOrphan } from "./process";
import { deployProcess } from "./deploy";

const procs: ProcessInfo[] = [];

const saveFilePath = "./processes.json";
const saveFile = Bun.file(saveFilePath);
if (!await saveFile.exists()) await Bun.write(saveFile, JSON.stringify([]), { createPath: true });

// Writes to a temp file in the same directory and renames it over processes.json,
// so a daemon kill (OOM, kill -9, host reboot) mid-write can never leave a
// truncated/corrupt file behind, since rename() is atomic on the same filesystem.
async function save() {
    const tmpPath = `${saveFilePath}.tmp`;
    await Bun.write(tmpPath, JSON.stringify(procs));
    await fs.rename(tmpPath, saveFilePath);
}

function createProcess(
    project: ProcessOptions,
    projectID: number = getNextProcessNumber(),
    initialLogFiles: string[] = [],
    restored: { commit?: string; lastDeploy?: DeployInfo } = {},
): ProcessInfo & { process: Process } {
    const proc = new Process({
        cwd: project.cwd,
        name: project.name,
        interpreter: project.interpreter,
        env: project.env,
        script: project.script,
        restart: project.restart,
        maxRestarts: project.maxRestarts,
        git: project.git,
        build: project.build,
    }, projectID, initialLogFiles);
    proc.commit = restored.commit;
    proc.lastDeploy = restored.lastDeploy;

    const procInfo: ProcessInfo = {
        startOptions: project,
        id: projectID,
        get status() {
            return proc.status;
        },
        get name() {
            return proc.info.name;
        },
        get pid() {
            return proc.pid;
        },
        get monit() {
            return proc.monit;
        },
        get lastError() {
            return proc.lastError;
        },
        get logFiles() {
            return proc.logFiles;
        },
        get commit() {
            return proc.commit;
        },
        get lastDeploy() {
            return proc.lastDeploy;
        },
    }

    Object.defineProperty(procInfo, "process", {
        enumerable: false,
        writable: true,
        value: proc
    });

    // Every successful spawn (including auto-restarts that never touch an HTTP
    // route) should immediately persist the fresh pid, not just route-driven actions.
    proc.on("spawned", () => {
        save().catch(err => console.error("[pdd] failed to persist process state:", err));
    });

    procs.push(procInfo);

    return procInfo as ProcessInfo & { process: Process };
}

async function respawn() {
    let projects: ProcessInfo[] = [];
    try {
        // A fresh handle, not the module-level `saveFile`: that instance was created
        // (and its "doesn't exist" state cached) before the initial Bun.write above on
        // a cold start, and reusing it here would read that stale empty state back.
        projects = await Bun.file(saveFilePath).json() as ProcessInfo[];
    } catch (err) {
        // This means total loss of process tracking: every managed process falls
        // back to an empty list. Log loudly so it shows up in journalctl instead
        // of silently eating every entry in processes.json.
        console.error("[pdd] processes.json is corrupt or unreadable, all managed process tracking is lost:", err);
        projects = [];
    }

    for (let project of projects) {
        // A previous run may have crashed without stopping its children (they're
        // spawned detached, so they can outlive the daemon). Clean up anything
        // still running under the last known PID before we spawn a replacement.
        // Falls back to the old monit.pid field for processes.json written before
        // pid was tracked independently of pidusage.
        const lastPid = project.pid ?? project.monit?.pid;
        const reclaimed = lastPid ? await killOrphan(lastPid) : true;

        const procInfo = createProcess(project.startOptions, project.id, project.logFiles ?? [], {
            commit: project.commit,
            lastDeploy: project.lastDeploy,
        });

        if (!reclaimed) {
            // The old pid might still be holding the port (or anything else it
            // owned); spawning a replacement on top of it would double-run the
            // process. Leave it in Error status for manual intervention instead.
            procInfo.process.status = Status.Error;
            procInfo.process.lastError = `could not reclaim pid ${lastPid}, refusing to double-spawn`;
            continue;
        }

        if (project.lastAction) await doAction(project.id, project.lastAction);
    }
}

function getNextProcessNumber(): number {
    return Math.max(0, ...procs.map(p => p.id)) + 1;
}

function getProjects(getter: Getter): ProcessInfo[] {
    if (getter === "all") {
        return [...procs];
    }
    const id = Number(getter);
    if (!isNaN(id) && Number.isInteger(id)) {
        const proc = procs.find(v => v.id === id);
        if (proc) return [proc];
    }
    return procs.filter(v => v.name === getter);
}

async function doAction(getter: Getter, action: Actions) {
    const projects = getProjects(getter);
    await Promise.all(
        projects.map(async p => {
            p.lastAction = action;
            await p.process?.[action]()
        })
    );
    return projects;
}

// Daemon shutdown only. Stops every child directly instead of going through
// doAction(), which would record lastAction = "stop" on each and make the next
// boot's respawn() leave everything stopped (e.g. after `systemctl restart pdd`
// or `pd update`). Leaving lastAction alone means respawn() brings back exactly
// what was running before.
async function stopAllForShutdown(): Promise<void> {
    await Promise.all(procs.map(p => p.process?.stop()));
}

async function start(options: Getter | ProcessOptions): Promise<ActionResult> {
    if (typeof options === "number" || typeof options === "string") {
        // Custom logic
        const projects = await doAction(options, "start");
        return { affected: projects.map(p => p.id), processes: await list() };
    }

    const procInfo = createProcess(options);

    // A git-backed process clones + builds before its first spawn, so a brand new
    // node can be set up with a single POST /start.
    if (options.git) {
        const result = await deployProcess(procInfo.process);
        if (!result.ok) {
            // Left without a lastAction so respawn() doesn't keep retrying a broken
            // checkout on every daemon boot; `pd deploy` fixes it up.
            procInfo.process.status = Status.Error;
            procInfo.process.lastError = `deploy failed: ${result.error}`;
            return { affected: [procInfo.id], processes: await list(), deploys: [result] };
        }
        await procInfo.process.start();
        procInfo.lastAction = "start";
        return { affected: [procInfo.id], processes: await list(), deploys: [result] };
    }

    await procInfo.process.start();
    procInfo.lastAction = "start";
    return { affected: [procInfo.id], processes: await list() };
}

// Deploys run one process at a time (not Promise.all like the other actions):
// "deploy all" on a small node shouldn't run every app's build concurrently.
async function deploy(getter: Getter, force = false): Promise<DeployActionResult> {
    // "all" means every git-backed process; naming a non-git one explicitly is
    // reported as an error in its DeployResult instead of being silently skipped.
    const projects = getProjects(getter).filter(p => getter !== "all" || p.startOptions.git);
    const deploys: DeployResult[] = [];
    for (const p of projects) {
        if (!p.process) continue;
        // Inferring git config from an existing checkout only for an explicitly
        // named process: "all" must never start hard-resetting checkouts that
        // were never opted in.
        const result = await deployProcess(p.process, { force, inferGit: getter !== "all" });
        deploys.push(result);
        if (result.ok && result.inferredGit) p.startOptions.git = result.inferredGit;
        if (!result.ok) {
            // The old code is still running (or rolled back); flag it in `pd ls`.
            p.process.lastError = `deploy failed: ${result.error}`;
            continue;
        }
        if (p.process.lastError?.startsWith("deploy failed")) p.process.lastError = undefined;
        const status = p.process.status;
        // Stopped stays stopped (the new code is picked up on the next start).
        // Error is included: the new commit may well be the fix for a crash loop,
        // or the first successful clone for a process whose cwd was missing.
        if (result.changed && (status === Status.Online || status === Status.Starting || status === Status.Error)) {
            p.lastAction = "restart";
            await p.process.restart();
        }
    }
    return { affected: projects.map(p => p.id), processes: await list(), deploys };
}

async function stop(getter: Getter): Promise<ActionResult> {
    const projects = await doAction(getter, "stop");
    return { affected: projects.map(p => p.id), processes: await list() };
}

async function restart(getter: Getter): Promise<ActionResult> {
    const projects = await doAction(getter, "restart");
    return { affected: projects.map(p => p.id), processes: await list() };
}

async function remove(getter: Getter): Promise<ActionResult> {
    const projects = await doAction(getter, "remove");
    const affected = projects.map(p => p.id);
    for (const proc of projects) {
        const idx = procs.findIndex(v => v.id === proc.id);
        if (idx !== -1) procs.splice(idx, 1);
    }
    return { affected, processes: await list() };
}

async function updateEnv(getter: Getter, envVars: Record<string, string>, replace = false): Promise<ActionResult> {
    const projects = getProjects(getter);
    await Promise.all(
        projects.map(async p => {
            if (!p.process) return;
            p.process.setEnv(envVars, replace);
            p.startOptions.env = p.process.info.env;
            if (p.process.status === Status.Online || p.process.status === Status.Starting) {
                p.lastAction = "restart";
                await p.process.restart();
            }
        })
    );
    return { affected: projects.map(p => p.id), processes: await list() };
}

// Patches the stored ProcessOptions (name, cwd, script, interpreter, restart,
// maxRestarts, env) in place. Like updateEnv(), options are only read at spawn
// time, so a running process is restarted to apply them.
async function updateConfig(getter: Getter, patch: Partial<ProcessOptions>): Promise<ActionResult> {
    const projects = getProjects(getter);
    await Promise.all(
        projects.map(async p => {
            if (!p.process) return;
            p.process.setOptions(patch);
            p.startOptions = { ...p.startOptions, ...patch };
            if (p.process.status === Status.Online || p.process.status === Status.Starting) {
                p.lastAction = "restart";
                await p.process.restart();
            }
        })
    );
    return { affected: projects.map(p => p.id), processes: await list() };
}

async function list() {
    await Promise.all(procs.map(v => v.process?.getResourceUsage()));
    return [...procs];
}

const proc = {
    getProjects,
    start,
    stop,
    stopAllForShutdown,
    restart,
    remove,
    env: updateEnv,
    deploy,
    config: updateConfig,
    list,
    save,
    respawn
}

export default proc;