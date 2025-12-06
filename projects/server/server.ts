import express from "express";
import proc from "./process"
import { readFileSync } from "fs";
import path from "path";

proc.loadProcesses()

const app = express();

app.use(express.json())

app.get("/list", (req, res) => {
    res.json(proc.list());
});

app.post("/start", (req, res) => {
    console.log(req.body)

    const body = req.body;

    const process = proc.startProc({
        cwd: body.cwd,
        name: body.name,
        script: body.script,
        interpreter: body.interpreter
    });
    res.json(process)
});

app.get("/delete/:id", (req, res) => {
    proc.deleteProc(req.params.id);
    res.send("Stopped")
});

// TODO: Live logs using SSE
// This requires events from the proc or "something"
// proc.event.on("out", (msg)=>{}) ????
app.get("/logs/:id", (req,res)=> {
    const id = req.params.id;

    let text;

    if (req.query.err) {
        const logErrorPath = path.join(proc.logDir, `${id}.err.log`);
        text = readFileSync(logErrorPath);
    } else {
        const logOutPath = path.join(proc.logDir, `${id}.out.log`);
        text = readFileSync(logOutPath);
    }

    
    res.type("text")
    res.send(text);
})

app.listen("3830", () => {
    console.log("Running at :3830")
});