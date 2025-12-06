import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import type { ManagedProcess, ProcessOptions, CustomSpawn } from "../types";

export const processes: ManagedProcess[] = [];

let processIdCounter = 1;

export const logDir = path.join(process.cwd(), "logs");
fs.mkdirSync(logDir, { recursive: true });

// Where we save state
const dataDir = path.join(process.cwd());
const dbPath = path.join(dataDir, "processes.json");

fs.mkdirSync(dataDir, { recursive: true });

// ---------- PERSISTENCE LAYER ----------

function saveProcesses() {
    const toSave = processes.map(p => ({
        id: p.id,
        name: p.name,
        config: p.config,
        restart: p.restart
    }));

    fs.writeFileSync(dbPath, JSON.stringify(toSave, null, 2));
}

export function loadProcesses() {
    if (!fs.existsSync(dbPath)) return;

    const raw = fs.readFileSync(dbPath, "utf8");
    if (!raw.trim()) return;

    const arr: any[] = JSON.parse(raw);

    for (const saved of arr) {
        // update ID counter so we don't conflict
        const idNum = Number(saved.id);
        processIdCounter = Math.max(processIdCounter, idNum) + 1;
        

        const proc = startProc(saved.config, idNum);
        proc.id = saved.id;
        proc.restart = saved.restart ?? false;
    }
}

// ---------- PROCESS MANAGER ----------

export function startProc(options: ProcessOptions | string, forcedID?: number) {
    if (typeof options === "string") {
        throw new Error("start(string) not implemented");
    }

    const { name, script = ".", cwd, interpreter = "bun", restart = true } = options;

    const proc: ManagedProcess = {
        id: forcedID ? String(forcedID) : String(processIdCounter++),
        name,
        config: options,
        started: Date.now(),
        restart: restart,
        status: "stopped"
    };

    const logOutPath = path.join(logDir, `${proc.id}.out.log`);
    const logErrorPath = path.join(logDir, `${proc.id}.err.log`);

    function getOutputFiles() {
        fs.writeFileSync(logOutPath, "");
        fs.writeFileSync(logErrorPath, "");

        const out = fs.createWriteStream(logOutPath, { flags: "a" });
        const err = fs.createWriteStream(logErrorPath, { flags: "a" });
        return { out, err }
    }

    function spawnProcess() {
        const { out, err } = getOutputFiles();
        const child: CustomSpawn = spawn(interpreter, [script], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        proc.child = child;
        proc.status = "online";

        out.write(`-- Started '${proc.name}' --\n`);
        err.write(`-- Started '${proc.name}' --\n`);

        child.stdout?.pipe(out, { end: false });
        child.stderr?.pipe(err, { end: false });

        child.on("exit", (code) => {
            proc.lastExit = Date.now();
            proc.lastCode = code;
            proc.status = "error";
            if (out.writable) out.write(`-- Exited with code '${code}' --\n`);
            if (err.writable) err.write(`-- Exited with code '${code}' --\n`);

            out.end();
            err.end();

            if (proc.restart && !child.__noRestart) {
                setTimeout(spawnProcess, 5 * 1000);
            }
        });
    }

    spawnProcess();

    processes.push(proc);
    saveProcesses(); // 🔥 save on start

    return proc;
}

export function logsProc(id: string) {
    const logOutPath = path.join(logDir, `${id}.out.log`);
    const logErrorPath = path.join(logDir, `${id}.err.log`);

    const logs = fs.readFileSync(logOutPath);
    const errors = fs.readFileSync(logErrorPath);

    return {
        logs, errors
    }
}


export function deleteProc(id: string) {
    const index = processes.findIndex(p => p.id === id);
    if (index === -1) return;

    const proc = processes[index];
    if (!proc) return;

    proc.restart = false;
    if (proc.child) {
        proc.child.__noRestart = true;
        proc.child.kill("SIGTERM");
    }

    processes.splice(index, 1);
    saveProcesses(); // 🔥 save after removal
}

export function restartProc(id: string) {
    const old = processes.find(p => p.id === id);
    if (!old) throw new Error("Process not found");

    if (old.child) {
        old.child.__noRestart = true;
        old.child.kill("SIGTERM");
    }

    const newProc = startProc(old.config);
    newProc.id = old.id;      // preserve ID
    newProc.restart = old.restart;

    // swap
    const index = processes.findIndex(p => p.id === id);
    processes[index] = newProc;

    saveProcesses();

    return newProc;
}

export function list() {
    return processes.map(p => ({
        id: p.id,
        name: p.name,
        pid: p.child?.pid || null,
        script: p.config.script,
        interpreter: p.config.interpreter ?? "bun",
        cwd: p.config.cwd,
        lastExit: p.lastExit,
        lastCode: p.lastCode,
        uptime: p.child ? Date.now() - p.started : 0,
        status: p.status,
        restart: p.restart
    }));
}

export default {
    startProc,
    deleteProc,
    list,
    restartProc,
    loadProcesses,
    logDir
}