#!/usr/bin/env bun

import { Command } from "commander";
import { spawnSync } from "child_process";
import { isAxiosError } from "axios";
import * as p from "@clack/prompts";
import path from "path";
import readline from "node:readline";
import { readdirSync, statSync } from "node:fs";
import { ProcClient } from "../client/index";
import { Status, type ActionResult, type ProcessInfo, type ProcessOptions } from "../types";
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
}

interface EcosystemFile {
    apps?: EcosystemApp[];
}

function normalizeApp(app: EcosystemApp): ProcessOptions {
    return {
        name: app.name,
        cwd: app.cwd ?? process.cwd(),
        ...(app.script && { script: app.script }),
        ...(app.interpreter && { interpreter: app.interpreter }),
        ...((app.autorestart || app.restart) && { restart: true }),
        ...((app.max_restarts !== undefined || app.maxRestarts !== undefined) && {
            maxRestarts: app.max_restarts ?? app.maxRestarts,
        }),
        ...(app.env && { env: app.env }),
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
    return apps.map(normalizeApp);
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

    // Build PM2-compatible entry
    const entry: EcosystemApp = {
        name: opts.name,
        cwd: opts.cwd,
        ...(opts.script && { script: opts.script }),
        ...(opts.interpreter && { interpreter: opts.interpreter }),
        ...(opts.restart && { autorestart: true }),
        ...(opts.maxRestarts !== undefined && { max_restarts: opts.maxRestarts }),
        ...(opts.env && { env: opts.env }),
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
        if (!isAxiosError(e) || e.code !== "ECONNREFUSED") throw e;
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

const COLOR = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function colorStatus(s: string): string {
    if (!process.stdout.isTTY) return s;
    if (s === Status.Online) return COLOR.green(s);
    if (s === Status.Error) return COLOR.red(s);
    if (s === Status.Stopped || s === Status.Stopping) return COLOR.yellow(s);
    return s;
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
        error: p.lastError ?? "-",
    }));

    const headers = { marker: "", id: "ID", name: "NAME", status: "STATUS", cpu: "CPU", mem: "MEM", uptime: "UPTIME", pid: "PID", error: "ERROR" };
    const baseCols = ["id", "name", "status", "cpu", "mem", "uptime", "pid"] as const;
    const withMarker = showMarker ? ["marker", ...baseCols] : baseCols as readonly string[];
    const cols = hasErrors ? [...withMarker, "error"] : withMarker;

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

async function interactiveNew(): Promise<ProcessOptions | null> {
    p.intro("New process");

    const name = await p.text({ message: "Process name", validate: v => v?.trim() ? undefined : "Required" });
    if (p.isCancel(name)) { p.cancel("Cancelled."); return null; }

    const cwd = await promptPath("Working directory", process.cwd());
    if (cwd === null) { p.cancel("Cancelled."); return null; }

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

    const config: ProcessOptions = {
        name: name as string,
        cwd,
        script,
        interpreter,
        ...(autoRestart && { restart: true }),
        ...(maxRestarts !== undefined && { maxRestarts }),
        ...(Object.keys(env).length && { env }),
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
                cwd: opts.cwd,
                ...(opts.script && { script: opts.script }),
                ...(opts.interpreter && { interpreter: opts.interpreter }),
                ...(opts.restart && { restart: true }),
                ...(opts.maxRestarts !== undefined && { maxRestarts: opts.maxRestarts }),
                ...(Object.keys(env).length && { env }),
            };
            const s = p.spinner();
            s.start(`Starting ${config.name}`);
            const result = await client.start(config);
            s.stop(`Started ${config.name}`);
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
    .command("logs <getter>")
    .description("Show logs for a process")
    .option("--out", "Show stdout only")
    .option("--err", "Show stderr only")
    .option("--runs <n>", "Number of past runs to show (default: 3)", Number)
    .option("-f, --follow", "Stream live logs after showing history, until Ctrl+C")
    .action(async (getter: string, opts) => {
        await ensureDaemon();
        const runs: number = opts.runs ?? 3;
        const { out, err } = await client.logs(getter, { runs });

        const showOut = !opts.err;
        const showErr = !opts.out;

        if (showOut && out) {
            if (showErr) process.stdout.write(process.stdout.isTTY ? COLOR.dim("── stdout ──\n") : "── stdout ──\n");
            process.stdout.write(out.endsWith("\n") ? out : out + "\n");
        }
        if (showErr && err) {
            if (showOut) process.stderr.write(process.stdout.isTTY ? COLOR.dim("── stderr ──\n") : "── stderr ──\n");
            process.stderr.write(err.endsWith("\n") ? err : err + "\n");
        }

        if (!opts.follow) return;

        process.stdout.write(process.stdout.isTTY ? COLOR.dim("── streaming live logs (Ctrl+C to exit) ──\n") : "── streaming live logs (Ctrl+C to exit) ──\n");
        const controller = new AbortController();
        process.on("SIGINT", () => {
            controller.abort();
            process.exit(0);
        });
        await client.streamLogs(getter, msg => {
            if (msg.type === "out" && showOut) process.stdout.write(msg.line);
            if (msg.type === "err" && showErr) process.stderr.write(msg.line);
        }, controller.signal).catch(e => {
            if (isAxiosError(e) && e.code === "ERR_CANCELED") return;
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

program.parseAsync(process.argv);
