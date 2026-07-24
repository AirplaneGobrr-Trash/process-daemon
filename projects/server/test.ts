import { Process } from "./process";

const cwd = "/home/apgb-node/Github/custom-pm2";
const script = "test.script.ts";

const proc = new Process({
    cwd: cwd,
    script: script,
    restart: false,
    name: "Test_script"
}, 1);

await proc.start();
proc.on("out", async (data) => {
    console.log(await proc.getResourceUsage())
    console.log(data)
});