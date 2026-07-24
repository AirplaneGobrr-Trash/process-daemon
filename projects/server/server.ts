import express from "express";
import proc from "./manager"
import type { ProcessOptions } from "../types";

const app = express();
app.use(express.json());

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

app.get("/list", asyncRoute(async (_req, res) => {
    res.json(await proc.list());
}));

app.post("/start", asyncRoute(async (req, res) => {
    const body = req.body as ProcessOptions;
    if (!body?.name?.trim() || !body?.cwd?.trim()) {
        return res.status(400).json({ error: "name and cwd are required" });
    }
    const process = await proc.start({
        cwd: body.cwd,
        name: body.name,
        script: body.script,
        interpreter: body.interpreter,
        env: body.env,
        restart: body.restart,
        maxRestarts: body.maxRestarts,
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

app.get("/logs/:id", asyncRoute<{ id: string }>(async (req, res) => {
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

app.listen("3830", () => {
    console.log("Running at :3830")
});

// Stop managed processes on the way down instead of leaving them running
// detached and untracked (e.g. during `pd update`'s systemctl restart, or a
// plain `systemctl stop`). Bounded so a child ignoring SIGTERM can't hang the
// daemon's own shutdown; killOrphan() on the next respawn() cleans up anything
// that doesn't die in time.
async function shutdown(signal: string) {
    console.log(`[pdd] received ${signal}, stopping managed processes...`);
    try {
        await Promise.race([
            proc.stop("all"),
            new Promise(r => setTimeout(r, 5000)),
        ]);
        await proc.save();
    } catch (err) {
        console.error("[pdd] error during shutdown:", err);
    }
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
