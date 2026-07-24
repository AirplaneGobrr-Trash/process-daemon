import { Process } from "./projects/server/process";
import path from "path";

async function main() {
    const proc = new Process({
        name: "test-proc",
        script: "test-script.js",
        cwd: path.join(process.cwd()),
        env: {
            EXAMPLE_VAR: "123"
        },
        restart: false
    }, 1);

    // Listen to stdout/stderr events
    proc.on("out", (msg) => {
        if (msg.type === "out") {
            console.log("OUT:", msg.line.trim());
        } else {
            console.log("ERR:", msg.line.trim());
        }
    });

    console.log("Starting process...");
    await proc.start();

    await Bun.sleep(5000)

    console.log("Process ended? Status:", proc.status);
    console.log("Exit code:", proc.lastCode);

    const logs = await proc.readLogFiles();
    console.log("---- LOG FILE CONTENTS ----");
    console.log("STDOUT:\n", logs.out);
    console.log("STDERR:\n", logs.err);

    console.log("Removing process...");
    await proc.remove();
}

main().catch(console.error);
