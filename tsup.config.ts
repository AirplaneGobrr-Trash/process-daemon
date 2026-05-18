import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["projects/client/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    outDir: "dist",
});
