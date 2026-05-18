import { $ } from "bun";

const targets = [
    { target: "bun-linux-x64",   arch: "x64" },
    { target: "bun-linux-arm64", arch: "arm64" },
] as const;

for (const { target, arch } of targets) {
    process.stdout.write(`Building pdd-linux-${arch}... `);
    await $`bun build --compile --target=${target} ./projects/server/server.ts --outfile ./pdd-linux-${arch}`.quiet();
    console.log("done");

    process.stdout.write(`Building pd-linux-${arch}... `);
    await $`bun build --compile --target=${target} ./projects/cli/index.ts --outfile ./pd-linux-${arch}`.quiet();
    console.log("done");
}