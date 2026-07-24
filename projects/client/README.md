# @airplanegobrr/process-daemon: Client SDK

The client SDK talks to a running `pdd` daemon over HTTP.

## Install

```bash
bun add @airplanegobrr/process-daemon
# or
npm install @airplanegobrr/process-daemon
pnpm add @airplanegobrr/process-daemon
```

## Setup

ESM / TypeScript:
```ts
import { ProcClient } from "@airplanegobrr/process-daemon";

const pd = new ProcClient();                             // defaults to http://localhost:3830
const pd = new ProcClient("http://192.168.1.10:3830");  // remote instance
```

CJS:
```js
const { ProcClient } = require("@airplanegobrr/process-daemon");

const pd = new ProcClient();
```

---

## API

### `pd.start(config)` - start a new process

```ts
await pd.start({
    name: "myapp",
    cwd: "/home/user/myapp",
    script: "index.ts",       // relative to cwd, defaults to "." (runs the package)
    interpreter: "bun",       // defaults to "bun"
    restart: true,            // auto-restart on crash, defaults to false
    maxRestarts: 5,           // max auto-restarts before giving up, defaults to 5
    env: { PORT: "3000" }     // extra environment variables
});
```

### `pd.start(getter)` - start a stopped process

```ts
await pd.start("myapp");  // by name
await pd.start(1);        // by ID
```

### `pd.list()` - list all processes

```ts
const processes = await pd.list();
```

Each entry is a `ProcessInfo`:

```ts
interface ProcessInfo {
    id: number;
    name: string;
    status: "starting" | "online" | "stopping" | "stopped" | "error";
    lastAction?: "start" | "stop" | "restart" | "remove";
    lastError?: string;
    monit?: {
        cpu: number;      // percentage
        memory: number;   // bytes
        pid: number;
        elapsed: number;  // ms since start
    };
}
```

### `pd.stop(getter)` / `pd.restart(getter)` / `pd.remove(getter)`

All accept a name, numeric ID, or `"all"`.

```ts
await pd.stop("myapp");
await pd.restart(1);
await pd.remove("all");
```

### `pd.setEnv(getter, env, options?)` - update a process's env vars

Merges the given vars into the process's existing env by default. Pass `{ replace: true }` to drop everything else. If the process is currently running, it's restarted immediately so the change takes effect (env is only read at spawn time); a stopped process just has its stored options updated for the next start.

```ts
await pd.setEnv("myapp", { PORT: "4000" });                       // merge
await pd.setEnv("myapp", { PORT: "4000" }, { replace: true });    // replace entirely
```

### `pd.logs(getter)` - get stdout and stderr

```ts
const { out, err } = await pd.logs("myapp");
const { out, err } = await pd.logs("myapp", { runs: 1 }); // last run only
```

### `pd.streamLogs(getter, onMessage, signal?)` - live stdout/stderr

Resolves once the connection ends (process removed, server closes it, or `signal` is aborted). Matches every process the getter resolves to, including `"all"`.

```ts
const controller = new AbortController();

await pd.streamLogs("myapp", (msg) => {
    console.log(`[${msg.id}] ${msg.type}: ${msg.line}`);
}, controller.signal);
```

---

## Examples

### Keep a web server alive

```ts
await pd.start({
    name: "api",
    cwd: "/home/user/my-api",
    script: "index.ts",
    restart: true,
    env: { PORT: "3000", NODE_ENV: "production" }
});
```

### Deploy - pull and restart

```ts
import { execSync } from "child_process";

execSync("git pull", { cwd: "/home/user/my-api" });
await pd.restart("api");
```

### Health check

```ts
const processes = await pd.list();
const api = processes.find(p => p.name === "api");

if (api?.status === "error") {
    console.error("api is down:", api.lastError);
    await pd.restart("api");
}
```

### Status table

```ts
const processes = await pd.list();

for (const p of processes) {
    const mem = p.monit ? `${(p.monit.memory / 1024 / 1024).toFixed(1)} MB` : "-";
    const cpu = p.monit ? `${p.monit.cpu.toFixed(1)}%` : "-";
    console.log(`[${p.id}] ${p.name} - ${p.status} | cpu: ${cpu} mem: ${mem}`);
}
```

### Start multiple processes at once

```ts
await Promise.all([
    pd.start({ name: "api",    cwd: "/home/user/api",    script: "index.ts", restart: true }),
    pd.start({ name: "worker", cwd: "/home/user/worker", script: "index.ts", restart: true }),
    pd.start({ name: "cron",   cwd: "/home/user/cron",   script: "index.ts", restart: false }),
]);
```
