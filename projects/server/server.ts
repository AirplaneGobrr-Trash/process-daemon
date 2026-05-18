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
        restart: body.restart
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
    const logs = await project.process?.readLogFiles();
    if (!logs) return res.status(404).json({ error: "No logs / Process not running" });
    res.json(logs);
});

app.listen("3830", () => {
    console.log("Running at :3830")
});
