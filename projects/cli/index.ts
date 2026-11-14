#!/usr/bin/env bun

import { Command } from "commander";
import { spawnSync } from "child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import path from "path";
import readline from "node:readline";
import { readdirSync, statSync } from "node:fs";
import { ProcClient, ProcClientError, discover, isConnectionRefused, readLocalToken, localConfigPath } from "../client/index";
import { Status, type ActionResult, type DaemonConfig, type DeployResult, type ProcessInfo, type ProcessOptions } from "../types";
import {
    CURRENT_VERSION,
    compareVersions,
    fetchLatestRelease,
    installUpdate,
    printUpdateNagIfAvailable,
    refreshUpdateCacheIfStale,
} from "./update";

// ── Ecosystem file support ────────────────────────────────────────────────────

const ECOSYSTEM_FILENAMES = [
    "ecosystem.config.js",
    "ecosystem.config.cjs",
    "ecosystem.config.json",
    "ecosystem.json",
];

interface EcosystemApp {
    name: string;
    cwd?: string;
    script?: string;
    interpreter?: string;
    // PM2 field names
    autorestart?: boolean;
    max_restarts?: number;
    // native field names
    restart?: boolean;
    maxRestarts?: number;
    env?: Record<string, string>;
    // git deploys
    repo?: string;
    branch?: string;
    build?: string[] | string;
    // PM2's name for commands run after `pm2 pull`
    post_update?: string[];
}

function toCommandList(v: string[] | string | undefined): string[] | undefined {
    if (v === undefined) return undefined;
    const list = (Array.isArray(v) ? v : [v]).map(c => c.trim()).filter(Boolean);
    return list.length ? list : undefined;
}

interface EcosystemFile {
    apps?: EcosystemApp[];
}

// The daemon runs from its own directory, so every cwd must be absolute by the
// time it's sent. A relative (or missing) cwd in an ecosystem file is resolved
// against the file's own directory, matching PM2, so the file stays portable.
function normalizeApp(app: EcosystemApp, ecoDir: string): ProcessOptions {
    return {
        name: app.name,
        cwd: path.resolve(ecoDir, app.cwd ?? "."),
        ...(app.script && { script: app.script }),
        ...(app.interpreter && { interpreter: app.interpreter }),
        ...((app.autorestart || app.restart) && { restart: true }),
        ...((app.max_restarts !== undefined || app.maxRestarts !== undefined) && {
            maxRestarts: app.max_restarts ?? app.maxRestarts,
        }),
        ...(app.env && { env: app.env }),
        ...(app.repo && { git: { repo: app.repo, ...(app.branch && { branch: app.branch }) } }),
        ...(toCommandList(app.build ?? app.post_update) && { build: toCommandList(app.build ?? app.post_update) }),
    };
}

async function loadEcosystemFile(filePath: string): Promise<ProcessOptions[]> {
    const resolved = path.resolve(filePath);
    let raw: EcosystemFile | EcosystemApp[];

    if (filePath.endsWith(".js") || filePath.endsWith(".cjs")) {
        const mod = await import(resolved);
        raw = mod.default ?? mod;
    } else {
        raw = await Bun.file(resolved).json();
    }

    const apps = Array.isArray(raw) ? raw : (raw.apps ?? []);
    const ecoDir = path.dirname(resolved);
    return apps.map(app => normalizeApp(app, ecoDir));
}

async function findEcosystemFile(): Promise<string | null> {
    for (const name of ECOSYSTEM_FILENAMES) {
        const candidate = path.join(process.cwd(), name);
        if (await Bun.file(candidate).exists()) return candidate;
    }
    return null;
}

async function appendToEcosystemFile(filePath: string, opts: ProcessOptions): Promise<void> {
    const resolved = path.resolve(filePath);
    const f = Bun.file(resolved);
    let data: EcosystemFile = { apps: [] };

    if (await f.exists()) {
        try { data = await f.json(); } catch {}
        if (!data.apps) data.apps = [];
    }

    // Store cwd relative to the ecosystem file ("." when they're the same dir),
    // so the file keeps working if the project is moved or cloned elsewhere.
    const relCwd = path.relative(path.dirname(resolved), path.resolve(opts.cwd)) || ".";

    // Build PM2-compatible entry
    const entry: EcosystemApp = {
        name: opts.name,
        cwd: relCwd,
        ...(opts.script && { script: opts.script }),
        ...(opts.interpreter && { interpreter: opts.interpreter }),
        ...(opts.restart && { autorestart: true }),
        ...(opts.maxRestarts !== undefined && { max_restarts: opts.maxRestarts }),
        ...(opts.env && { env: opts.env }),
        ...(opts.git && { repo: opts.git.repo, ...(opts.git.branch && { branch: opts.git.branch }) }),
        ...(opts.build?.length && { build: opts.build }),
    };

    (data.apps ??= []).push(entry);
    await Bun.write(resolved, JSON.stringify(data, null, 2) + "\n");
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const kv of pairs) {
        const eq = kv.indexOf("=");
        if (eq === -1) { process.stderr.write(`error: invalid env var "${kv}" (expected KEY=VALUE)\n`); process.exit(1); }
        env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return env;
}

// ── Path prompt with tab completion ──────────────────────────────────────────

function makePathCompleter(baseCwd?: string) {
    return (line: string): [string[], string] => {
        const endsWithSep = line.endsWith(path.sep) || line.endsWith("/");
        const dir = endsWithSep ? (line || ".") : (path.dirname(line) || ".");
        const base = endsWithSep ? "" : path.basename(line);
        // Resolve against baseCwd for filesystem access while keeping completions relative
        const resolvedDir = baseCwd && !path.isAbsolute(dir) ? path.join(baseCwd, dir) : dir;
        let hits: string[] = [];
        try {
            hits = readdirSync(resolvedDir)
                .filter(f => f.startsWith(base))
                .map(f => {
                    const relFull = path.join(dir, f);
                    try { return statSync(path.join(resolvedDir, f)).isDirectory() ? relFull + path.sep : relFull; }
                    catch { return relFull; }
                });
        } catch {}
        return [hits, line];
    };
}

async function promptPath(message: string, defaultValue = "", baseCwd?: string): Promise<string | null> {
    return new Promise(resolve => {
        const hint = defaultValue ? `\x1b[2m (${defaultValue})\x1b[0m` : "";
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            completer: makePathCompleter(baseCwd),
        });
        rl.question(`\x1b[35m◆\x1b[0m  ${message}${hint} › `, answer => {
            rl.close();
            resolve(answer.trim() || defaultValue || "");
        });
        rl.on("SIGINT", () => {
            rl.close();
            process.stdout.write("\n");
            resolve(null);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────

const client = new ProcClient();

async function ensureDaemon(): Promise<void> {
    try {
        await client.list();
        return;
    } catch (e) {
        if (e instanceof ProcClientError && e.status === 401) {
            process.stderr.write(`error: pdd rejected the API token\n  → pd reads it from ${localConfigPath()}; check that file is readable by you\n`);
            process.exit(1);
        }
        if (!isConnectionRefused(e)) throw e;
    }

    const bunPath = Bun.which("bun");
    if (bunPath) {
        await Bun.write("/var/lib/pdd/env", `PATH=${path.dirname(bunPath)}:/usr/local/bin:/usr/bin:/bin\n`).catch(() => {});
    }

    process.stderr.write("Starting pdd daemon...\n");
    const result = spawnSync("sudo", ["systemctl", "start", "pdd"], { stdio: "inherit" });
    if (result.status !== 0) {
        process.stderr.write("error: failed to start pdd\n  → try: sudo systemctl start pdd\n");
        process.exit(1);
    }

    for (let i = 0; i < 20; i++) {
        await Bun.sleep(300);
        try {
            await client.list();
            return;
        } catch {}
    }

    process.stderr.write("error: pdd started but not responding on :3830\n");
    process.exit(1);
}

function fmtUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function fmtMem(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Forced on: callers already gate every use behind the relevant stream's own
// isTTY check (stdout vs stderr), so picocolors' own auto-detection (which
// only looks at stdout) would otherwise wrongly suppress color on a
// stderr-bound string when stdout happens to be piped.
const COLOR = pc.createColors(true);

function colorStatus(s: string): string {
    if (!process.stdout.isTTY) return s;
    if (s === Status.Online) return COLOR.green(s);
    if (s === Status.Error) return COLOR.red(s);
    if (s === Status.Stopped || s === Status.Stopping) return COLOR.yellow(s);
    return s;
}

// Every run's start/end marker lines bracket that run's content within a
// stream's raw log blob. Splitting on them turns the flat concatenated text
// pd used to dump into one block per run, so a crash-restart cycle reads as
// "this run did X then died" instead of two disjoint stdout/stderr walls the
// reader has to cross-reference by timestamp.
const RUN_MARKER = /^-- Process \(\d+\) (.+) at (.+) --$/;

interface LogRun {
    startTs?: string;
    endTs?: string;
    verb?: string; // undefined while the run is still live (no end marker yet)
    lines: string[];
}

function parseLogRuns(blob: string): LogRun[] {
    if (!blob) return [];
    const lines = blob.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const runs: LogRun[] = [];
    let current: LogRun | undefined;
    for (const line of lines) {
        const m = line.match(RUN_MARKER);
        if (m) {
            const [, verb, ts] = m;
            if (verb === "started") {
                current = { startTs: ts, lines: [] };
                runs.push(current);
            } else if (current) {
                current.verb = verb;
                current.endTs = ts;
            }
            continue;
        }
        current?.lines.push(line);
    }
    return runs;
}

interface CombinedRun {
    startTs?: string;
    endTs?: string;
    verb?: string;
    outLines: string[];
    errLines: string[];
}

// out/err are always written together on every spawn (see process.ts's
// start()), so the nth run parsed out of each blob is the same run.
function combineLogRuns(out: string, err: string): CombinedRun[] {
    const outRuns = parseLogRuns(out);
    const errRuns = parseLogRuns(err);
    const count = Math.max(outRuns.length, errRuns.length);
    const combined: CombinedRun[] = [];
    for (let i = 0; i < count; i++) {
        const o = outRuns[i];
        const e = errRuns[i];
        combined.push({
            startTs: o?.startTs ?? e?.startTs,
            endTs: o?.endTs ?? e?.endTs,
            verb: o?.verb ?? e?.verb,
            outLines: o?.lines ?? [],
            errLines: e?.lines ?? [],
        });
    }
    return combined;
}

function fmtDuration(startTs: string, endTs: string): string {
    const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRunHeader(run: CombinedRun, isTTY: boolean): string {
    const time = run.startTs ? new Date(run.startTs).toLocaleTimeString() : "?";
    let status: string;
    if (!run.verb) status = isTTY ? COLOR.green("running") : "running";
    else if (run.verb.startsWith("errored")) {
        const text = `${run.verb} after ${fmtDuration(run.startTs!, run.endTs!)}`;
        status = isTTY ? COLOR.red(text) : text;
    } else if (run.verb === "exited") {
        const text = `exited after ${fmtDuration(run.startTs!, run.endTs!)}`;
        status = isTTY ? COLOR.dim(COLOR.green(text)) : text;
    } else {
        const text = `${run.verb} after ${fmtDuration(run.startTs!, run.endTs!)}`;
        status = isTTY ? COLOR.dim(text) : text;
    }
    const dash = isTTY ? COLOR.dim("──") : "──";
    return `${dash} ${time} → ${status} ${dash}`;
}

function printLogRuns(out: string, err: string, showOut: boolean, showErr: boolean): void {
    const runs = combineLogRuns(out, err);
    if (runs.length === 0) {
        const stream = showOut ? process.stdout : process.stderr;
        stream.write(stream.isTTY ? COLOR.dim("-- no logs --\n") : "-- no logs --\n");
        return;
    }

    for (const run of runs) {
        process.stdout.write(fmtRunHeader(run, process.stdout.isTTY) + "\n");

        let printed = false;
        if (showOut) {
            for (const line of run.outLines) process.stdout.write(line + "\n");
            printed ||= run.outLines.length > 0;
        }
        if (showErr) {
            for (const line of run.errLines) {
                process.stderr.write((process.stderr.isTTY ? COLOR.red(line) : line) + "\n");
            }
            printed ||= run.errLines.length > 0;
        }
        if (!printed) continue;
        process.stdout.write("\n");
    }
}

function printTable(procs: ProcessInfo[], highlight?: Set<number>): void {
    if (procs.length === 0) {
        console.log("No processes.");
        return;
    }

    const hasErrors = procs.some(p => p.lastError);
    const showMarker = !!highlight && highlight.size > 0;

    const rows = procs.map(p => ({
        marker: highlight?.has(p.id) ? "→" : "",
        id: String(p.id),
        name: p.name,
        status: p.status ?? "unknown",
        cpu: p.monit ? `${p.monit.cpu.toFixed(1)}%` : "-",
        mem: p.monit ? fmtMem(p.monit.memory) : "-",
        uptime: p.monit ? fmtUptime(p.monit.elapsed) : "-",
        pid: p.monit ? String(p.monit.pid) : "-",
        commit: p.commit ? p.commit.slice(0, 7) : "-",
        error: p.lastError ?? "-",
    }));

    // Like ERROR, only shown when at least one process is git-backed.
    const hasCommits = procs.some(p => p.commit);
    const headers = { marker: "", id: "ID", name: "NAME", status: "STATUS", cpu: "CPU", mem: "MEM", uptime: "UPTIME", pid: "PID", commit: "COMMIT", error: "ERROR" };
    const baseCols = ["id", "name", "status", "cpu", "mem", "uptime", "pid"] as const;
    const withMarker = showMarker ? ["marker", ...baseCols] : baseCols as readonly string[];
    const withCommit = hasCommits ? [...withMarker, "commit"] : withMarker;
    const cols = hasErrors ? [...withCommit, "error"] : withCommit;

    const widths = Object.fromEntries(
        cols.map(c => [c, Math.max(headers[c as keyof typeof headers].length, ...rows.map(r => r[c as keyof typeof r].length))])
    ) as Record<string, number>;

    const pad = (s: string, w: number) => s.padEnd(w);

    console.log(cols.map(c => pad(headers[c as keyof typeof headers], widths[c]!)).join("  "));
    console.log(cols.map(c => "─".repeat(widths[c]!)).join("  "));

    for (const row of rows) {
        const cells = cols.map(c => {
            const val = pad(row[c as keyof typeof row], widths[c]!);
            if (c === "marker" && row.marker) return process.stdout.isTTY ? COLOR.yellow(val) : val;
            if (c === "status") return colorStatus(val);
            if (c === "error" && row.error !== "-") return process.stdout.isTTY ? COLOR.red(val) : val;
            return val;
        });
        console.log(cells.join("  "));
    }
}

// pd and pdd are separate binaries; if pdd wasn't restarted after a pd update
// (e.g. `pd update`'s service restart failed), an older daemon can still return
// a bare ProcessInfo[] instead of an ActionResult, so guard before indexing in.
function printActionResult(result: ActionResult, highlight?: Set<number>): void {
    if (!result || !Array.isArray(result.processes)) {
        process.stderr.write("error: unexpected response from pdd - the daemon may be running an older version.\n  → try: sudo systemctl restart pdd\n");
        process.exit(1);
    }
    printTable(result.processes, highlight);
}

// One line per deploy, plus the git/build output for failures (or always, with verbose).
function printDeploys(result: { deploys?: DeployResult[]; processes?: ProcessInfo[] }, verbose = false): boolean {
    const deploys = result.deploys ?? [];
    const tty = process.stdout.isTTY;
    const short = (sha?: string) => sha ? sha.slice(0, 7) : "?";
    let allOk = true;
    for (const d of deploys) {
        const name = result.processes?.find(p => p.id === d.id)?.name ?? `#${d.id}`;
        let line: string;
        if (!d.ok) {
            allOk = false;
            const rb = d.rolledBack ? ` (rolled back to ${short(d.commit)})` : "";
            line = `✗ ${name}: ${d.error}${rb}`;
            line = tty ? COLOR.red(line) : line;
        } else if (!d.changed) {
            line = `· ${name}: already up to date (${short(d.commit)})`;
            line = tty ? COLOR.dim(line) : line;
        } else {
            const from = d.previousCommit ? `${short(d.previousCommit)} → ` : "cloned at ";
            line = `✓ ${name}: ${from}${short(d.commit)}`;
            line = tty ? COLOR.green(line) : line;
        }
        if (verbose || !d.ok) {
            const out = d.output.trimEnd();
            if (out) console.log((tty ? COLOR.dim(out) : out) + "\n");
        }
        console.log(line);
        if (d.ok && d.inferredGit) {
            const msg = `  now git-backed: ${d.inferredGit.repo.replace(/(\/\/)[^/@\s]+@/g, "$1***@")} (${d.inferredGit.branch})`;
            console.log(tty ? COLOR.dim(msg) : msg);
        }
    }
    if (deploys.length) console.log("");
    return allOk;
}

async function interactiveNew(): Promise<ProcessOptions | null> {
    p.intro("New process");

    const name = await p.text({ message: "Process name", validate: v => v?.trim() ? undefined : "Required" });
    if (p.isCancel(name)) { p.cancel("Cancelled."); return null; }

    const cwdInput = await promptPath("Working directory", process.cwd());
    if (cwdInput === null) { p.cancel("Cancelled."); return null; }
    const cwd = path.resolve(cwdInput);

    const script = await promptPath("Script / entrypoint", ".", cwd);
    if (script === null) { p.cancel("Cancelled."); return null; }

    const interpChoice = await p.select({
        message: "Interpreter",
        options: [
            { value: "bun",     label: "bun" },
            { value: "node",    label: "node" },
            { value: "python3", label: "python3" },
            { value: "other",   label: "other…" },
        ],
    });
    if (p.isCancel(interpChoice)) { p.cancel("Cancelled."); return null; }

    let interpreter = interpChoice as string;
    if (interpreter === "other") {
        const custom = await p.text({ message: "Interpreter command" });
        if (p.isCancel(custom)) { p.cancel("Cancelled."); return null; }
        interpreter = custom as string;
    }

    const autoRestart = await p.confirm({ message: "Auto-restart on crash?" });
    if (p.isCancel(autoRestart)) { p.cancel("Cancelled."); return null; }

    let maxRestarts: number | undefined;
    if (autoRestart) {
        const maxR = await p.text({
            message: "Max restarts",
            defaultValue: "5",
            placeholder: "5",
            validate: v => v && (isNaN(Number(v)) || Number(v) < 1) ? "Must be a positive number" : undefined,
        });
        if (p.isCancel(maxR)) { p.cancel("Cancelled."); return null; }
        maxRestarts = Number(maxR);
    }

    const envRaw = await p.text({ message: "Env vars", placeholder: "KEY=VAL KEY2=VAL2  (leave blank to skip)" });
    if (p.isCancel(envRaw)) { p.cancel("Cancelled."); return null; }

    const env: Record<string, string> = {};
    for (const kv of (envRaw as string).trim().split(/\s+/).filter(Boolean)) {
        const eq = kv.indexOf("=");
        if (eq !== -1) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    const repo = await p.text({ message: "Git repo URL", placeholder: "leave blank to skip (cwd is cloned into if missing/empty)" });
    if (p.isCancel(repo)) { p.cancel("Cancelled."); return null; }

    let git: ProcessOptions["git"];
    let build: string[] | undefined;
    if ((repo as string)?.trim()) {
        const branch = await p.text({ message: "Branch", defaultValue: "main", placeholder: "main" });
        if (p.isCancel(branch)) { p.cancel("Cancelled."); return null; }
        git = { repo: (repo as string).trim(), branch: (branch as string) || "main" };

        const buildRaw = await p.text({ message: "Build commands, separated by ;", placeholder: "bun install; bun run build  (leave blank to skip)" });
        if (p.isCancel(buildRaw)) { p.cancel("Cancelled."); return null; }
        build = toCommandList(((buildRaw as string) ?? "").split(";"));
    }

    const config: ProcessOptions = {
        name: name as string,
        cwd,
        script,
        interpreter,
        ...(autoRestart && { restart: true }),
        ...(maxRestarts !== undefined && { maxRestarts }),
        ...(Object.keys(env).length && { env }),
        ...(git && { git }),
        ...(build && { build }),
    };

    const saveEco = await p.confirm({ message: "Save to ecosystem file?" });
    if (!p.isCancel(saveEco) && saveEco) {
        const ecoPath = await promptPath("Ecosystem file path", "ecosystem.json");
        if (ecoPath !== null) {
            await appendToEcosystemFile(ecoPath, config);
            p.log.success(`Saved to ${ecoPath}`);
        }
    }

    return config;
}

const program = new Command("pd")
    .description("process-daemon CLI")
    .version(CURRENT_VERSION);

program.hook("preAction", (_thisCommand, actionCommand) => {
    // Fire-and-forget: refreshes the cached "latest version" if it's stale, never
    // blocks the actual command. Skipped for `update` since it does its own fresh check.
    if (actionCommand.name() !== "update") void refreshUpdateCacheIfStale();
});

program.hook("postAction", async (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "update") await printUpdateNagIfAvailable();
});

program
    .command("list")
    .alias("ls")
    .description("List all processes")
    .action(async () => {
        await ensureDaemon();
        printTable(await client.list());
    });

program
    .command("start [getter]")
    .description("Start a process by name/id, from an ecosystem file, or define a new one")
    .option("--name <name>", "Process name (new process)")
    .option("--cwd <cwd>", "Working directory (new process)")
    .option("--script <script>", "Script/entrypoint")
    .option("--interpreter <interpreter>", "Interpreter (default: bun)")
    .option("--restart", "Auto-restart on crash")
    .option("--max-restarts <n>", "Max restart attempts", Number)
    .option("--env <kv...>", "Environment variables as KEY=VALUE")
    .option("--git <repo>", "Git repo to clone into cwd and deploy from (new process)")
    .option("--branch <branch>", "Git branch (default: main)")
    .option("--build <cmd...>", "Build commands run after every clone/fetch, e.g. --build \"bun install\" \"bun run build\"")
    .option("--efile [path]", "Start from ecosystem file (auto-detects ecosystem.config.js/json if no path given)")
    .action(async (getter: string | undefined, opts) => {
        await ensureDaemon();

        // Start existing process by name/id
        if (getter !== undefined) {
            const result = await client.start(getter);
            printActionResult(result, new Set(result.affected));
            return;
        }

        // Ecosystem file path: --efile <path>, --efile alone (auto-detect), or auto-detect when no other flags
        const wantsEco = opts.efile !== undefined;
        const noNewProcessFlags = !opts.name && !opts.cwd;

        if (wantsEco || noNewProcessFlags) {
            let ecoPath: string | null = null;

            if (typeof opts.efile === "string") {
                ecoPath = opts.efile;
            } else {
                ecoPath = await findEcosystemFile();
            }

            if (ecoPath) {
                let apps: ProcessOptions[];
                try {
                    apps = await loadEcosystemFile(ecoPath);
                } catch (e) {
                    process.stderr.write(`error: could not read ecosystem file "${ecoPath}": ${e}\n`);
                    process.exit(1);
                }

                if (apps.length === 0) {
                    process.stderr.write(`error: no apps found in "${ecoPath}"\n`);
                    process.exit(1);
                }

                console.log(`Starting ${apps.length} process${apps.length === 1 ? "" : "es"} from ${path.basename(ecoPath)}`);
                let lastResult: ActionResult = { affected: [], processes: [] };
                const affected = new Set<number>();
                for (const app of apps) {
                    const s = p.spinner();
                    s.start(app.name);
                    lastResult = await client.start(app);
                    for (const id of lastResult.affected) affected.add(id);
                    s.stop(app.name);
                    printDeploys(lastResult);
                }
                printActionResult(lastResult, affected);
                return;
            }

            // No ecosystem file found and --efile not explicitly given → fall through to interactive
            if (wantsEco) {
                process.stderr.write("error: no ecosystem file found\n");
                process.exit(1);
            }
        }

        // Flag-based new process
        if (opts.name && opts.cwd) {
            const env = parseEnvPairs((opts.env ?? []) as string[]);
            const config: ProcessOptions = {
                name: opts.name,
                cwd: path.resolve(opts.cwd),
                ...(opts.script && { script: opts.script }),
                ...(opts.interpreter && { interpreter: opts.interpreter }),
                ...(opts.restart && { restart: true }),
                ...(opts.maxRestarts !== undefined && { maxRestarts: opts.maxRestarts }),
                ...(Object.keys(env).length && { env }),
                ...(opts.git && { git: { repo: opts.git, ...(opts.branch && { branch: opts.branch }) } }),
                ...(toCommandList(opts.build) && { build: toCommandList(opts.build) }),
            };
            const s = p.spinner();
            s.start(config.git ? `Cloning, building and starting ${config.name}` : `Starting ${config.name}`);
            const result = await client.start(config);
            s.stop(`Started ${config.name}`);
            printDeploys(result);
            printActionResult(result, new Set(result.affected));
            return;
        }

        // Interactive
        const newProc = await interactiveNew();
        if (!newProc) process.exit(0);
        const s = p.spinner();
        s.start(`Starting ${newProc.name}`);
        const result = await client.start(newProc);
        s.stop(`Started ${newProc.name}`);
        printDeploys(result);
        printActionResult(result, new Set(result.affected));
    });

program
    .command("stop <getter>")
    .description("Stop a process (name, id, or all)")
    .action(async (getter: string) => {
        await ensureDaemon();
        const result = await client.stop(getter);
        printActionResult(result, new Set(result.affected));
    });

program
    .command("restart <getter>")
    .description("Restart a process (name, id, or all)")
    .action(async (getter: string) => {
        await ensureDaemon();
        const result = await client.restart(getter);
        printActionResult(result, new Set(result.affected));
    });

program
    .command("remove <getter>")
    .alias("rm")
    .description("Remove a process (name, id, or all)")
    .action(async (getter: string) => {
        await ensureDaemon();
        const result = await client.remove(getter);
        printActionResult(result, new Set(result.affected));
    });

program
    .command("env <getter> <kv...>")
    .description("Update environment variables for a process (name, id, or all); restarts it if running")
    .option("--replace", "Replace all env vars instead of merging")
    .action(async (getter: string, kv: string[], opts) => {
        await ensureDaemon();
        const env = parseEnvPairs(kv);
        const result = await client.setEnv(getter, env, { replace: !!opts.replace });
        printActionResult(result, new Set(result.affected));
    });

program
    .command("logs <getter> [runs]")
    .description("Show logs for a process, grouped per run (default: last 1 run)")
    .option("--out", "Show stdout only")
    .option("--err", "Show stderr only")
    .option("--runs <n>", "Number of past runs to show (overrides the positional arg)", Number)
    .option("-f, --follow", "Stream live logs after showing history, until Ctrl+C")
    .action(async (getter: string, runsArg: string | undefined, opts) => {
        await ensureDaemon();

        let runs = 1;
        if (opts.runs !== undefined) {
            runs = opts.runs;
        } else if (runsArg !== undefined) {
            runs = Number(runsArg);
        }
        if (!Number.isInteger(runs) || runs < 1) {
            process.stderr.write(`error: invalid run count "${opts.runs ?? runsArg}"\n`);
            process.exit(1);
        }

        const { out, err } = await client.logs(getter, { runs });

        const showOut = !opts.err;
        const showErr = !opts.out;

        printLogRuns(out, err, showOut, showErr);

        if (!opts.follow) return;

        process.stdout.write(process.stdout.isTTY ? COLOR.dim("── streaming live logs (Ctrl+C to exit) ──\n") : "── streaming live logs (Ctrl+C to exit) ──\n");
        const controller = new AbortController();
        process.on("SIGINT", () => {
            controller.abort();
            process.exit(0);
        });
        await client.streamLogs(getter, msg => {
            if (msg.type === "out" && showOut) process.stdout.write(msg.line);
            if (msg.type === "err" && showErr) process.stderr.write(process.stderr.isTTY ? COLOR.red(msg.line) : msg.line);
        }, controller.signal).catch(e => {
            if ((e as Error)?.name === "AbortError") return;
            throw e;
        });
    });

program
    .command("update")
    .description("Update pd and pdd to the latest GitHub release")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (opts) => {
        const s = p.spinner();
        s.start("Checking for updates");
        let release;
        try {
            release = await fetchLatestRelease();
        } catch (e) {
            s.stop("Failed to check for updates");
            process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
            process.exit(1);
        }
        s.stop(`Latest release: ${release.tag}`);

        if (compareVersions(release.version, CURRENT_VERSION) <= 0) {
            console.log(`Already up to date (v${CURRENT_VERSION}).`);
            return;
        }

        console.log(`\n${release.name}  (v${CURRENT_VERSION} → v${release.version})\n`);
        if (release.body.trim()) {
            console.log(release.body.trim());
            console.log("");
        }

        if (!opts.yes) {
            const confirmed = await p.confirm({
                message: "Install this update? This overwrites the current pd/pdd binaries and restarts the pdd service.",
            });
            if (p.isCancel(confirmed) || !confirmed) {
                p.cancel("Cancelled.");
                return;
            }
        }

        try {
            await installUpdate(release);
        } catch (e) {
            process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
            process.exit(1);
        }

        console.log(`Updated to v${release.version}.`);
    });

program
    .command("deploy <getter>")
    .description("Pull (or clone) the latest commit for git-backed processes, run their build commands, and restart them if the commit changed")
    .option("-f, --force", "Rebuild and restart even if already up to date")
    .option("-v, --verbose", "Print git/build output for successful deploys too")
    .action(async (getter: string, opts) => {
        await ensureDaemon();
        const s = p.spinner();
        s.start(`Deploying ${getter}`);
        const result = await client.deploy(getter, { force: !!opts.force });
        s.stop(`Deployed ${getter}`);
        if (result.deploys.length === 0) {
            console.log(getter === "all" ? "No git-backed processes." : `No process matches "${getter}".`);
            return;
        }
        const ok = printDeploys(result, !!opts.verbose);
        printActionResult(result, new Set(result.affected));
        if (!ok) process.exitCode = 1;
    });

// ── Daemon settings: auth / bind address ─────────────────────────────────────

const PUBLIC_NO_AUTH_WARNING = "auth is disabled and pdd is listening on 0.0.0.0: anyone who can reach port 3830 can run commands on this machine";

function discoveryLabel(cfg: DaemonConfig): string {
    if (!cfg.discoverable) return "off";
    return cfg.host === "0.0.0.0" ? "on" : "on (inactive while local)";
}

function hostLabel(host: string): string {
    return host === "0.0.0.0" ? "public (0.0.0.0)" : "local (127.0.0.1)";
}

function printDaemonConfig(cfg: DaemonConfig): void {
    const tty = process.stdout.isTTY;
    const auth = cfg.authEnabled ? "enabled" : "disabled";
    console.log(`auth:   ${tty ? (cfg.authEnabled ? COLOR.green(auth) : COLOR.yellow(auth)) : auth}`);
    console.log(`listen: ${hostLabel(cfg.host)}`);
    console.log(`broadcast: ${discoveryLabel(cfg)}`);
    if (!cfg.authEnabled && cfg.host === "0.0.0.0") warn(PUBLIC_NO_AUTH_WARNING);
}

function warn(msg: string): void {
    process.stderr.write((process.stderr.isTTY ? COLOR.yellow(`warning: ${msg}`) : `warning: ${msg}`) + "\n");
}

// The token is read from the daemon's config.json rather than over the API, so it
// works even with auth enabled and never crosses the network.
function printToken(): void {
    const token = readLocalToken();
    if (!token) {
        process.stderr.write(`error: could not read the token from ${localConfigPath()}\n`);
        process.exit(1);
    }
    console.log(token);
}

// After a rebind the old listener is gone and the new one may take a moment.
async function waitForDaemon(): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
        await Bun.sleep(150);
        try {
            await client.list();
            return true;
        } catch {}
    }
    return false;
}

async function setHost(mode: "local" | "public"): Promise<DaemonConfig> {
    const cfg = await client.setHost(mode);
    if (!await waitForDaemon()) {
        process.stderr.write("error: pdd did not come back after switching its listen address\n  → check: journalctl -u pdd -n 50\n");
        process.exit(1);
    }
    return cfg;
}

const auth = program.command("auth").description("Manage API token authentication");

auth.command("token")
    .description("Print the API token")
    .action(async () => {
        await ensureDaemon();
        printToken();
    });

auth.command("status")
    .description("Show whether auth is enabled and where pdd is listening")
    .action(async () => {
        await ensureDaemon();
        printDaemonConfig(await client.getDaemonConfig());
    });

auth.command("enable")
    .description("Require the API token on every request")
    .action(async () => {
        await ensureDaemon();
        printDaemonConfig(await client.setAuthEnabled(true));
    });

auth.command("disable")
    .description("Allow requests without a token")
    .action(async () => {
        await ensureDaemon();
        printDaemonConfig(await client.setAuthEnabled(false));
    });

auth.command("rotate")
    .description("Generate a new API token (remote clients must be given the new one)")
    .action(async () => {
        await ensureDaemon();
        const cfg = await client.rotateToken();
        console.log(cfg.token);
        if (!cfg.authEnabled) warn("auth is currently disabled, so the token isn't being enforced (pd auth enable)");
    });

program
    .command("server [mode] [value]")
    .description("Show or set where pdd listens (local = 127.0.0.1, public = 0.0.0.0), or toggle LAN discovery (broadcast on|off)")
    .action(async (mode: string | undefined, value: string | undefined) => {
        await ensureDaemon();
        if (mode === undefined || mode === "status") {
            printDaemonConfig(await client.getDaemonConfig());
            return;
        }
        if (mode === "broadcast") {
            if (value !== "on" && value !== "off") {
                process.stderr.write(`error: expected "pd server broadcast on" or "pd server broadcast off"\n`);
                process.exit(1);
            }
            const cfg = await client.setDiscoverable(value === "on");
            printDaemonConfig(cfg);
            if (cfg.discoverable && cfg.host !== "0.0.0.0") warn("pdd only answers discovery while public (pd server public)");
            return;
        }
        if (mode !== "local" && mode !== "public") {
            process.stderr.write(`error: unknown mode "${mode}" (expected local, public, or broadcast on|off)\n`);
            process.exit(1);
        }
        printDaemonConfig(await setHost(mode));
    });

program
    .command("discover")
    .description("Find pdd daemons on the local network (ones that are public with broadcast on)")
    .option("-t, --timeout <ms>", "How long to wait for replies", Number, 1500)
    .action(async (opts) => {
        const s = p.spinner();
        s.start("Looking for pdd on the network");
        const found = await discover({ timeoutMs: opts.timeout });
        s.stop(`Found ${found.length} daemon${found.length === 1 ? "" : "s"}`);
        if (found.length === 0) return;
        const rows = found.map(d => ({ host: d.hostname, url: `http://${d.address}:${d.port}`, version: d.version, auth: d.authEnabled ? "on" : "off" }));
        const headers = { host: "HOST", url: "URL", version: "VERSION", auth: "AUTH" };
        const cols = Object.keys(headers) as (keyof typeof headers)[];
        const w = Object.fromEntries(cols.map(c => [c, Math.max(headers[c].length, ...rows.map(r => r[c].length))])) as Record<string, number>;
        console.log(cols.map(c => headers[c].padEnd(w[c]!)).join("  "));
        console.log(cols.map(c => "─".repeat(w[c]!)).join("  "));
        for (const r of rows) console.log(cols.map(c => r[c].padEnd(w[c]!)).join("  "));
    });

program
    .command("config")
    .description("Interactively change pdd's settings (auth, listen address, token)")
    .action(async () => {
        await ensureDaemon();
        p.intro("pdd settings");
        while (true) {
            const cfg = await client.getDaemonConfig();
            if (!cfg.authEnabled && cfg.host === "0.0.0.0") p.log.warn(PUBLIC_NO_AUTH_WARNING);
            const choice = await p.select({
                message: "What do you want to change?",
                options: [
                    { value: "auth", label: `Auth: ${cfg.authEnabled ? "enabled" : "disabled"}`, hint: cfg.authEnabled ? "disable" : "enable" },
                    { value: "host", label: `Listen: ${hostLabel(cfg.host)}`, hint: cfg.host === "0.0.0.0" ? "switch to local" : "switch to public" },
                    { value: "broadcast", label: `Broadcast: ${discoveryLabel(cfg)}`, hint: cfg.discoverable ? "turn off" : "turn on" },
                    { value: "token", label: "Show token" },
                    { value: "rotate", label: "Rotate token" },
                    { value: "done", label: "Done" },
                ],
            });
            if (p.isCancel(choice) || choice === "done") break;

            if (choice === "auth") {
                if (cfg.authEnabled && cfg.host === "0.0.0.0") {
                    const ok = await p.confirm({ message: "pdd is listening publicly. Disabling auth lets anyone who can reach it run commands. Continue?", initialValue: false });
                    if (p.isCancel(ok) || !ok) continue;
                }
                await client.setAuthEnabled(!cfg.authEnabled);
                p.log.success(`Auth ${cfg.authEnabled ? "disabled" : "enabled"}`);
            } else if (choice === "host") {
                const next = cfg.host === "0.0.0.0" ? "local" : "public";
                if (next === "public" && !cfg.authEnabled) {
                    const ok = await p.confirm({ message: "Auth is disabled. Going public lets anyone who can reach port 3830 run commands. Continue?", initialValue: false });
                    if (p.isCancel(ok) || !ok) continue;
                }
                await setHost(next);
                p.log.success(`Now listening on ${hostLabel(next === "public" ? "0.0.0.0" : "127.0.0.1")}`);
            } else if (choice === "broadcast") {
                const next = await client.setDiscoverable(!cfg.discoverable);
                p.log.success(`Broadcast ${discoveryLabel(next)}`);
            } else if (choice === "token") {
                const token = readLocalToken();
                if (token) p.note(token, "API token");
                else p.log.error(`could not read the token from ${localConfigPath()}`);
            } else if (choice === "rotate") {
                const ok = await p.confirm({ message: "Rotate the token? Remote clients (e.g. auto-deploy on another machine) will need the new one.", initialValue: false });
                if (p.isCancel(ok) || !ok) continue;
                const result = await client.rotateToken();
                p.note(result.token, "New API token");
            }
        }
        p.outro("Done");
    });

program.parseAsync(process.argv);
