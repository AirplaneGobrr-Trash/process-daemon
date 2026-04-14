import type { ProcessOptions, ProcessInfo, Getter, Actions } from "../types";
import { Process } from "./process";

const procs: ProcessInfo[] = [];

const saveFile = Bun.file("./processes.json");
if (!saveFile.exists()) await Bun.write(saveFile, JSON.stringify([]), { createPath: true });

async function save() {
    await Bun.write(saveFile, JSON.stringify(procs));
}

function createProcess(project: ProcessOptions, projectID: number = getNextProcessNumber()): ProcessInfo & { process: Process } {
    const proc = new Process({
        cwd: project.cwd,
        name: project.name,
        interpreter: project.interpreter,
        env: project.env,
        script: project.script,
        restart: project.restart
    });

    const procInfo: ProcessInfo = {
        startOptions: project,
        id: projectID,
        get status() {
            return proc.status;
        },
        get name() {
            return proc.info.name;
        },
        get monit() {
            return proc.monit;
        }
    }

    Object.defineProperty(procInfo, "process", {
        enumerable: false,
        writable: true,
        value: proc
    });

    procs.push(procInfo);

    return procInfo as ProcessInfo & { process: Process };
}

async function respawn() {
    const projects = await saveFile.json() as ProcessInfo[];

    for (let project of projects) {
        createProcess(project.startOptions, project.id);

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
    if (Number.isInteger(id)) {
        let proc = procs.find(v => v.id === id);
        if (proc) return [proc];
    }
    return [];
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

async function start(options: Getter | ProcessOptions) {
    if (typeof options === "number" || typeof options === "string") {
        // Custom logic
        return await doAction(options, "start");
    }

    const procInfo = createProcess(options);

    await procInfo.process.start();
    procInfo.lastAction = "start";
    return [procInfo];
}

async function stop(getter: Getter) {
    return await doAction(getter, "stop")
}

async function restart(getter: Getter) {
    return await doAction(getter, "restart")
}

async function remove(getter: Getter) {
    const projects = await doAction(getter, "remove");
    for (let proc of projects) {
        const idx = procs.findIndex(v => v.id === proc.id);
        if (idx !== -1) procs.splice(idx, 1);

    }
    return null;
}

async function list() {
    let e = await Promise.all(procs.map(v=>v.process?.getResourceUsage()));
    return [...procs];
}

const proc = {
    getProjects,
    start,
    stop,
    restart,
    remove,
    list,
    save,
    respawn
}

export default proc;