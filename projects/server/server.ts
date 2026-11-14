import express from "express";
import fs from "fs/promises";
import { existsSync } from "fs";
import proc from "./manager"
import { isAlive } from "./process";
import { startDiscoveryResponder } from "./discovery";
import { FileError, listDir, readText, writeText } from "./files";
import { runCommand } from "./exec";
import { VERSION, initSelfUpdate, status as updateStatus, update as selfUpdate } from "./selfupdate";
import { PORT, getConfig, loadConfig, publicView, saveConfig, tokenMatches, updateConfig, generateToken } from "./config";
import type { BindHost, ExecOptions, ProcessOptions } from "../types";
// Inlined as a string at build time, so the compiled pdd binary carries the
// dashboard with it and never reads it from disk.
import dashboardHtml from "./dashboard.html" with { type: "text" };

const app = express();
// Big enough for PUT /file (5MB of text, plus JSON escaping).
app.use(express.json({ limit: "12mb" }));

loadConfig();
// Persist immediately so a freshly generated token is on disk for `pd` and the
// SDK to read before the first request.
await saveConfig();

// Every route except the dashboard page itself requires the token while auth is
// on. Checked per request against the live config, so `pd auth disable/enable/rotate`
// take effect without a restart. GETs may pass it as ?token= instead, since the
// dashboard's EventSource can't set headers.
app.use((req, res, next) => {
    const config = getConfig();
    if (!config.authEnabled) return next();
    if (req.method === "GET" && req.path === "/") return next();
    const header = req.headers.authorization ?? "";
    let given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!given && req.method === "GET" && typeof req.query.token === "string") given = req.query.token;
    if (!given || !tokenMatches(given)) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid token (see `pd auth token`)" });
    }
    next();
});

const pidFilePath = "./pdd.pid";

// Refuses to start if another live instance already holds this pidfile, instead of
// silently racing it over processes.json and the port.
async function ensureSingleton() {
    if (existsSync(pidFilePath)) {
        const existingPid = Number((await fs.readFile(pidFilePath, "utf8")).trim());
        if (existingPid && isAlive(existingPid)) {
            console.error(`[pdd] another instance is already running (pid ${existingPid}), refusing to start`);
            process.exit(1);
        }
    }
    await fs.writeFile(pidFilePath, String(process.pid));
}

await ensureSingleton();

await proc.respawn();

// Last-resort net: catches anything outside a request context (e.g. the
// auto-restart setTimeout in process.ts) so a stray error can't take down
// every process pdd is managing along with it.
process.on("uncaughtException", (err) => {
    console.error("[pdd] uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
    console.error("[pdd] unhandled rejection:", reason);
});

// Express doesn't catch rejected promises from async handlers on its own,
// which would otherwise surface as an unhandledRejection and crash the daemon.
function asyncRoute<P = {}>(handler: (req: express.Request<P>, res: express.Response) => Promise<any>): express.RequestHandler<P> {
    return (req, res) => {
        handler(req, res).catch(err => {
            console.error("[pdd] route error:", err);
            if (!res.headersSent) res.status(500).json({ error: "Internal error" });
        });
    };
}

// Web dashboard: a single static page that only talks to the routes below
// (/list polling, /start|stop|restart/:id, /logs/:id and its SSE stream).
app.get("/", (_req, res) => {
    res.type("html").send(dashboardHtml);
});

app.get("/list", asyncRoute(async (_req, res) => {
    res.json(await proc.list());
}));

app.post("/start", asyncRoute(async (req, res) => {
    const body = req.body as ProcessOptions;
    if (!body?.name?.trim() || !body?.cwd?.trim()) {
        return res.status(400).json({ error: "name and cwd are required" });
    }
    if (body.git !== undefined && (typeof body.git?.repo !== "string" || !body.git.repo.trim()
        || (body.git.branch !== undefined && typeof body.git.branch !== "string"))) {
        return res.status(400).json({ error: "git.repo must be a non-empty string (git.branch optional string)" });
    }
    if (body.build !== undefined && (!Array.isArray(body.build) || !body.build.every(c => typeof c === "string"))) {
        return res.status(400).json({ error: "build must be an array of command strings" });
    }
    const process = await proc.start({
        cwd: body.cwd,
        name: body.name,
        script: body.script,
        interpreter: body.interpreter,
        env: body.env,
        restart: body.restart,
        maxRestarts: body.maxRestarts,
        ...(body.git && { git: { repo: body.git.repo.trim(), ...(body.git.branch && { branch: body.git.branch }) } }),
        ...(body.build && { build: body.build }),
    });
    await proc.save();
    res.json(process);
}));

app.post("/start/:getter", asyncRoute<{ getter: string }>(async (req, res) => {
    const output = await proc.start(req.params.getter);
    await proc.save();
    res.json(output);
}));

for (const action of ["stop", "restart", "remove"] as const) {
    app.post(`/${action}/:getter`, asyncRoute<{ getter: string }>(async (req, res) => {
        const output = await proc[action](req.params.getter);
        await proc.save();
        res.json(output);
    }));
}

app.post("/env/:getter", asyncRoute<{ getter: string }>(async (req, res) => {
    const { env, replace } = req.body as { env?: Record<string, string>; replace?: boolean };
    if (!env || typeof env !== "object") {
        return res.status(400).json({ error: "env is required" });
    }
    const output = await proc.env(req.params.getter, env, !!replace);
    await proc.save();
    res.json(output);
}));

// Only the known ProcessOptions fields are accepted, each type-checked, so a
// bad body can't smuggle arbitrary keys into processes.json.
function parseConfigPatch(body: any): Partial<ProcessOptions> | string {
    if (!body || typeof body !== "object") return "body must be an object";
    const patch: Partial<ProcessOptions> = {};
    for (const key of ["name", "cwd"] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "string" || !body[key].trim()) return `${key} must be a non-empty string`;
        patch[key] = body[key].trim();
    }
    for (const key of ["script", "interpreter"] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "string") return `${key} must be a string`;
        patch[key] = body[key].trim();
    }
    if (body.restart !== undefined) {
        if (typeof body.restart !== "boolean") return "restart must be a boolean";
        patch.restart = body.restart;
    }
    if (body.maxRestarts !== undefined) {
        if (!Number.isInteger(body.maxRestarts) || body.maxRestarts < 0) return "maxRestarts must be a non-negative integer";
        patch.maxRestarts = body.maxRestarts;
    }
    if (body.env !== undefined) {
        if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)
            || Object.values(body.env).some(v => typeof v !== "string")) return "env must be an object of strings";
        patch.env = { ...body.env };
    }
    if (body.git !== undefined) {
        // null clears it (the process stops being git-backed)
        if (body.git === null) patch.git = undefined;
        else if (typeof body.git !== "object" || typeof body.git.repo !== "string" || !body.git.repo.trim()
            || (body.git.branch !== undefined && typeof body.git.branch !== "string")) return "git must be { repo, branch? } or null";
        else patch.git = { repo: body.git.repo.trim(), ...(body.git.branch && { branch: body.git.branch }) };
    }
    if (body.build !== undefined) {
        if (!Array.isArray(body.build) || !body.build.every((c: unknown) => typeof c === "string")) return "build must be an array of command strings";
        patch.build = [...body.build];
    }
    return patch;
}

app.post("/config/:getter", asyncRoute<{ getter: string }>(async (req, res) => {
    const patch = parseConfigPatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });
    if (proc.getProjects(req.params.getter).length === 0) {
        return res.status(404).json({ error: "No project found with that getter" });
    }
    const output = await proc.config(req.params.getter, patch);
    await proc.save();
    res.json(output);
}));

app.post("/deploy/:getter", asyncRoute<{ getter: string }>(async (req, res) => {
    const { force } = (req.body ?? {}) as { force?: boolean };
    const output = await proc.deploy(req.params.getter, !!force);
    await proc.save();
    res.json(output);
}));

// ── Daemon settings ──────────────────────────────────────────────────────────
// Under /daemon, not /config (that's per-process options). The token itself is
// never returned except by rotate, to a caller that just proved it held the old
// one; local tools read it from config.json.

app.get("/daemon", (_req, res) => {
    res.json({ ...publicView(), version: VERSION });
});

app.post("/daemon/auto-update", asyncRoute(async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    res.json(publicView(await updateConfig({ autoUpdate: enabled })));
}));

// ?check=1 asks GitHub for the latest release first.
app.get("/daemon/update", asyncRoute(async (req, res) => {
    res.json(await updateStatus(req.query.check === "1" || req.query.check === "true"));
}));

// Installs the latest signed release and restarts into it (managed processes
// are stopped and brought back like on any daemon restart). Answers before the
// restart; poll GET /daemon until the version changes.
app.post("/daemon/update", asyncRoute(async (req, res) => {
    const { force } = (req.body ?? {}) as { force?: boolean };
    try {
        const result = await selfUpdate({ force: !!force });
        res.status(result.started ? 202 : 200).json(result);
    } catch (err) {
        res.status(502).json({ started: false, error: err instanceof Error ? err.message : String(err) });
    }
}));

app.post("/daemon/auth", asyncRoute(async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    const config = await updateConfig({ authEnabled: enabled });
    if (!enabled && config.host === "0.0.0.0") {
        console.warn("[pdd] auth disabled while listening publicly: anyone who can reach this port can run commands");
    }
    res.json(publicView(config));
}));

app.post("/daemon/discoverable", asyncRoute(async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    res.json(publicView(await updateConfig({ discoverable: enabled })));
}));

app.post("/daemon/token/rotate", asyncRoute(async (_req, res) => {
    const config = await updateConfig({ token: generateToken() });
    res.json({ ...publicView(config), token: config.token });
}));

app.post("/daemon/host", asyncRoute(async (req, res) => {
    const { host } = (req.body ?? {}) as { host?: string };
    if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        return res.status(400).json({ error: "host must be 127.0.0.1 or 0.0.0.0" });
    }
    const previous = getConfig().host;
    const config = await updateConfig({ host });
    // Rebind only once the response is flushed, or the caller would see its own
    // connection torn down instead of the answer.
    if (host !== previous) res.on("finish", () => void rebind(host, previous));
    res.json(publicView(config));
}));

// ── Run a command ───────────────────────────────────────────────────────────
// One-off shell command, in a process's cwd (with its env) or a given dir.

app.post("/exec", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as ExecOptions;
    if (typeof body.command !== "string" || !body.command.trim()) return res.status(400).json({ error: "command is required" });
    let cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
    let env: Record<string, string> = {};
    if (body.getter !== undefined && body.getter !== "") {
        const matches = proc.getProjects(String(body.getter));
        if (matches.length !== 1) return res.status(matches.length ? 400 : 404).json({ error: matches.length ? "getter matches more than one process; use its id" : "No project found with that getter" });
        cwd = matches[0]!.startOptions.cwd;
        env = matches[0]!.startOptions.env ?? {};
    }
    if (cwd && !existsSync(cwd)) return res.status(400).json({ error: `directory does not exist: ${cwd}` });
    res.json(await runCommand(body.command, cwd, env, typeof body.timeoutMs === "number" ? body.timeoutMs : undefined));
}));

// ── Files ───────────────────────────────────────────────────────────────────
// Read/write text files inside one process's cwd (?path= is relative to it).
// The getter has to match exactly one process.

function oneProcessCwd(getter: string, res: express.Response): string | undefined {
    const matches = proc.getProjects(getter);
    if (matches.length !== 1) {
        res.status(matches.length ? 400 : 404).json({ error: matches.length ? `"${getter}" matches ${matches.length} processes; use its id` : "No project found with that getter" });
        return;
    }
    return matches[0]!.startOptions.cwd;
}

function fileRoute<P extends { getter: string }>(handler: (cwd: string, sub: string, req: express.Request<P>, res: express.Response) => Promise<unknown>) {
    return asyncRoute<P>(async (req, res) => {
        const cwd = oneProcessCwd(req.params.getter, res);
        if (cwd === undefined) return;
        const sub = typeof req.query.path === "string" ? req.query.path : "";
        try {
            res.json(await handler(cwd, sub, req, res));
        } catch (err) {
            if (err instanceof FileError) return res.status(err.status).json({ error: err.message });
            throw err;
        }
    });
}

app.get("/files/:getter", fileRoute<{ getter: string }>((cwd, sub) => listDir(cwd, sub)));
app.get("/file/:getter", fileRoute<{ getter: string }>((cwd, sub) => readText(cwd, sub)));
app.put("/file/:getter", fileRoute<{ getter: string }>(async (cwd, sub, req) => {
    const content = (req.body as { content?: unknown })?.content;
    if (typeof content !== "string") throw new FileError(400, "body must be { content: string }");
    if (!sub) throw new FileError(400, "path is required");
    return writeText(cwd, sub, content);
}));

app.get("/logs/:id",asyncRoute<{ id: string }>(async (req, res) => {
    const id = req.params.id;
    const project = proc.getProjects(id)[0];
    if (!project) return res.status(404).json({ error: "No project found with that ID" });
    const runsParam = req.query.runs;
    const runs = runsParam !== undefined ? Number(runsParam) : undefined;
    const logs = await project.process?.readLogFiles(runs);
    if (!logs) return res.status(404).json({ error: "No logs found" });
    res.json(logs);
}));

app.get("/logs/:getter/stream", (req, res) => {
    const projects = proc.getProjects(req.params.getter);
    if (projects.length === 0) return res.status(404).json({ error: "No project found with that getter" });

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    });

    const listeners = projects.map(p => {
        const listener = (msg: { type: "out" | "err"; line: string }) => {
            res.write(`data: ${JSON.stringify({ id: p.id, ...msg })}\n\n`);
        };
        p.process?.on("out", listener);
        return { process: p.process, listener };
    });

    req.on("close", () => {
        for (const { process, listener } of listeners) {
            process?.off("out", listener);
        }
    });
});

let server: ReturnType<typeof app.listen> | undefined;

function listen(host: BindHost): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const s = app.listen(PORT, host, (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) return reject(err);
            server = s;
            console.log(`Running at ${host}:${PORT} (dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${PORT}/)`);
            resolve();
        });
        s.once("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

// Swaps the listener to a new bind address in place. If the new address can't
// be bound, falls back to the previous one (and reverts the saved config); if
// even that fails, exits non-zero so systemd's Restart=on-failure brings the
// daemon back up instead of leaving it running with no listener at all.
async function rebind(host: BindHost, previous: BindHost) {
    const old = server;
    old?.close();
    // Also drops open SSE log streams; `pd logs -f` clients just end.
    old?.closeAllConnections?.();
    for (const target of [host, previous]) {
        for (let i = 0; i < 10; i++) {
            try {
                await listen(target);
                if (target !== host) {
                    console.error(`[pdd] could not bind ${host}:${PORT}, reverted to ${previous}`);
                    await updateConfig({ host: previous });
                }
                return;
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") {
                    console.error(`[pdd] failed to bind ${target}:${PORT}:`, err);
                    break;
                }
                await Bun.sleep(200);
            }
        }
    }
    console.error("[pdd] no listener could be bound, exiting");
    process.exit(1);
}

await listen(getConfig().host);
startDiscoveryResponder();
if (!getConfig().authEnabled && getConfig().host === "0.0.0.0") {
    console.warn("[pdd] auth is disabled and the API is listening publicly: anyone who can reach this port can run commands");
}

// Stop managed processes on the way down instead of leaving them running
// detached and untracked (e.g. during `pd update`'s systemctl restart, or a
// plain `systemctl stop`). Bounded so a child ignoring SIGTERM can't hang the
// daemon's own shutdown; killOrphan() on the next respawn() cleans up anything
// that doesn't die in time.
async function shutdown(signal: string, exitCode = 0) {
    console.log(`[pdd] received ${signal}, stopping managed processes...`);
    try {
        await Promise.race([
            proc.stopAllForShutdown(),
            new Promise(r => setTimeout(r, 5000)),
        ]);
        await proc.save();
    } catch (err) {
        console.error("[pdd] error during shutdown:", err);
    }
    // Clean up so a future pid reused by an unrelated process doesn't fool the
    // next startup's singleton check into thinking it's still us.
    await fs.unlink(pidFilePath).catch(() => {});
    process.exit(exitCode);
}

// A self-update restarts by exiting non-zero after a clean shutdown, so systemd
// brings the new binary up whether the unit says Restart=always or on-failure.
await initSelfUpdate(() => shutdown("self-update", 75));

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
