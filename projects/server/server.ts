import express from "express";
import proc from "./manager"
import { readFileSync } from "fs";
import path from "path";
import type { Getter, ProcessOptions } from "../types";

const app = express();

app.use(express.json())

await proc.respawn();
const internalKeys = new Set(["save", "respawn", "getProjects"]);
const procKeys = Object.keys(proc) as Array<keyof typeof proc>;

for (const key of procKeys) {
    if (internalKeys.has(key)) continue;
    const fn = proc[key];

    if (typeof fn === "function") {
        let route = `/${key}`;

        if (fn.length == 1) {
            route += `/:getter`
        }

        app.get(route, async (req, res) => {
            const output = await proc[key](req.params?.getter!);
            await proc.save();
            res.json(output);
        });
    }
}

interface ActionBody {
    action: Array<keyof typeof proc>;
    getter: Getter;
}

// TODO: POST /action (See below dipshit)
// app.post("/action", (req, res)=>{
//     const body = req.body as ActionBody;
// });

app.post("/start", async (req, res) => {
    const body = req.body as ProcessOptions & { env?: Record<string, string> };

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

// TODO: Live logs using SSE
// This requires events from the proc or "something"
// proc.event.on("out", (msg)=>{}) ????
app.get("/logs/:id", async (req, res) => {
    const id = req.params.id;

    const project = proc.getProjects(id)[0];
    if (!project) return res.send("No project found with that ID");

    const logs = await project.process?.readLogFiles();
    if (!logs) return res.send("No logs / Process not running");

    let text;

    if (req.query.err) {
        text = logs.err;
    } else if (req.query.out) {
        text = logs.out;
    } else {
        return res.json(logs);
    }

    res.type("text");
    res.send(text);
})

app.listen("3830", () => {
    console.log("Running at :3830")
});