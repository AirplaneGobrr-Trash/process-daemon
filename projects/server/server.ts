import express from "express";
import proc from "./manager"
import type { ProcessOptions } from "../types";

const app = express();
app.use(express.json());

await proc.respawn();

app.get("/list", async (_req, res) => {
    res.json(await proc.list());
});

app.post("/start", async (req, res) => {
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
});

app.post("/start/:getter", async (req, res) => {
    const output = await proc.start(req.params.getter);
    await proc.save();
    res.json(output);
});

for (const action of ["stop", "restart", "remove"] as const) {
    app.post(`/${action}/:getter`, async (req, res) => {
        const output = await proc[action](req.params.getter);
        await proc.save();
        res.json(output);
    });
}

app.get("/logs/:id", async (req, res) => {
    const id = req.params.id;
    const project = proc.getProjects(id)[0];
    if (!project) return res.status(404).json({ error: "No project found with that ID" });
    const runsParam = req.query.runs;
    const runs = runsParam !== undefined ? Number(runsParam) : undefined;
    const logs = await project.process?.readLogFiles(runs);
    if (!logs) return res.status(404).json({ error: "No logs found" });
    res.json(logs);
});

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
