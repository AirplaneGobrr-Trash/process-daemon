# process-daemon: Agent Context

A minimal Bun-powered process manager built as a simpler alternative to PM2. The explicit goal is a codebase anyone can hold in their head. No plugin system, no cluster mode.

## Writing style

Never use em dashes (—) anywhere in this project. Use a regular hyphen (-), a colon, or restructure the sentence instead.

## Naming

- **`pdd`**: the daemon binary (`/usr/local/bin/pdd`). Runs as a systemd service.
- **`pd`**: the CLI binary (`/usr/local/bin/pd`). Talks to the daemon over HTTP.
- **`ProcClient`**: the TypeScript SDK class.
- Package name: `@airplanegobrr/process-daemon`

## Architecture

Three components, all in `projects/`:

```
projects/
  server/
    server.ts     : Express HTTP server, defines all routes
    manager.ts    : in-memory process list, persistence, actions
    process.ts    : child process lifecycle (spawn, log, restart)
  client/
    index.ts      : ProcClient SDK (axios wrapper)
  cli/
    index.ts      : pd CLI (Commander, uses ProcClient)
    update.ts     : version comparison, cached update-check, self-update install
  types.ts        : shared types across all components
```

The server exposes an HTTP API on `:3830`. The client SDK and CLI both talk to it. The daemon is the only thing that directly manages processes.

## HTTP API

| Method | Route              | Description                        |
|--------|--------------------|------------------------------------|
| GET    | `/list`            | List all processes with monit data |
| POST   | `/start`           | Start a new process (body: ProcessOptions), returns `ActionResult` |
| POST   | `/start/:getter`   | Start an existing stopped process, returns `ActionResult` |
| POST   | `/stop/:getter`    | Stop a process, returns `ActionResult`     |
| POST   | `/restart/:getter` | Restart a process, returns `ActionResult`  |
| POST   | `/remove/:getter`  | Stop and remove a process, returns `ActionResult` |
| GET    | `/logs/:getter`    | Returns `{ out: string, err: string }`. Optional `?runs=N` limits to the last N runs. |
| GET    | `/logs/:getter/stream` | Server-Sent Events stream of live stdout/stderr lines as they're produced, as `{ id, type: "out" \| "err", line }` frames. Matches every process the getter resolves to (including `"all"`). |

Mutations are POST. Always returns JSON.

## Getter

Most routes accept a `:getter` which can be:
- A numeric process ID (`1`, `2`, ...)
- A process name string (`"myapp"`)
- `"all"`: applies to every process

## Key types (`projects/types.ts`)

```ts
interface ProcessOptions {
    name: string;
    cwd: string;
    script?: string;       // defaults to "." (runs the package)
    interpreter?: string;  // defaults to "bun"
    restart?: boolean;     // auto-restart on crash
    maxRestarts?: number;  // default 5
    env?: Record<string, string>;
}

interface ProcessInfo {
    id: number;
    name: string;
    status: Status;        // "starting" | "online" | "stopping" | "stopped" | "error"
    lastAction?: Actions;
    lastError?: string;    // set on pre-flight failure or max restarts exceeded
    monit?: Stat;          // cpu, memory, pid, elapsed - populated by list()
    logFiles?: string[];   // base names of all log file pairs, persisted across daemon restarts
}

interface ActionResult {
    affected: number[];        // ids the action actually applied to
    processes: ProcessInfo[];  // full process list, refreshed (monit included) after the action ran
}
```

## Important design decisions

- **`process` on `ProcessInfo` is non-enumerable**: set via `Object.defineProperty` in `manager.ts` so it's excluded from `JSON.stringify` and never sent over the wire.
- **`status` / `name` / `monit` / `lastError` / `logFiles` are getters** on `ProcessInfo` that proxy to the `Process` instance. These are live values, not snapshots.
- **Restart count resets on manual start**: `start(isAutoRestart = false)` resets `restartCount` to 0. Auto-restarts pass `true` so the count accumulates correctly.
- **Restart count also resets after 30s of stable uptime**: each successful spawn starts a `stableTimer` that zeroes `restartCount` after 30 seconds if the process is still running. `onExit` clears the timer first, so a crash (manual stop, auto-restart, or otherwise) before the 30s mark never lets a stale timer reset the count out from under a fresh restart storm. This is what lets `maxRestarts` mean "N crashes in a row" instead of "N crashes ever".
- **`lastError` clears on successful spawn**: set to `undefined` when `status` transitions to `Online`.
- **Pre-flight checks set `Status.Error`**: missing interpreter/cwd/script sets error status immediately instead of getting stuck on `Starting`.
- **Routes are explicit, not dynamic**: an earlier version auto-generated routes by iterating `proc` object keys; replaced with an explicit list to avoid accidentally exposing `save`/`respawn`.
- **Processes.json is recovered gracefully**: `respawn()` wraps JSON parse in try/catch and defaults to `[]` on corrupt/empty file.
- **CLI auto-starts the daemon**: every `pd` command calls `ensureDaemon()` first; on `ECONNREFUSED` it writes `/var/lib/pdd/env` with the current bun PATH, then runs `sudo systemctl start pdd` and polls until `:3830` responds.
- **Interpreter is resolved to an absolute path**: `resolveInterpreter()` in `process.ts` tries `Bun.which` first, then falls back to known install locations (`~/.bun/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`). The resolved path is passed directly to `Bun.spawn`, so systemd's stripped PATH never causes a "No interpreter" error.
- **Bun PATH is written by the CLI, not hardcoded in the service**: `ensureDaemon()` writes `PATH=<bun-dir>:...` to `/var/lib/pdd/env` before starting the service. The service file uses `EnvironmentFile=-/var/lib/pdd/env` (the `-` means the file is optional, so cold starts without a prior `pd` invocation still work via `resolveInterpreter`'s fallback).
- **`pd list` shows ERROR column only when needed**: the column is omitted when no process has a `lastError`, keeping normal output clean. When present, errors are shown in red.
- **Ecosystem files are PM2-compatible**: `pd start` auto-detects `ecosystem.config.js`, `ecosystem.config.cjs`, `ecosystem.config.json`, or `ecosystem.json` in cwd. `--efile [path]` overrides the path. PM2 field names (`autorestart`, `max_restarts`) are normalized to the native ones on load. The save path (after interactive creation) always writes PM2-compatible JSON (`{ apps: [...] }`). JS/CJS files are loaded via dynamic `import()`.
- **`_stopping` is never reset inside `stop()`**: it is only cleared at the top of a manual `start()` call (`isAutoRestart = false`). This prevents a race where `onExit` fires as a separate microtask after `await exited` resolves but before `_stopping` was (previously) reset to `false`, and also stops any pending `setTimeout` auto-restart from firing after a manual stop (`start(true)` returns immediately when `_stopping` is set).
- **`getResourceUsage` guards against ESRCH**: checks `spawned.exitCode !== null` before calling `pidusage`, and wraps the call in try/catch to handle the narrow race where the process exits between the check and the pidusage call. Without this, `pd list` would 500 whenever any process was stopped.
- **Interactive path prompts use readline tab completion**: `cwd`, `script`, and ecosystem file path prompts bypass `@clack/prompts` (which has no completer hook) and use a `readline.createInterface` with a custom `completer`. The script completer receives the entered `cwd` as `baseCwd` so it resolves relative paths against that directory for the filesystem read, but returns completions as relative paths so the user types `src/index.ts` not `/srv/api/src/index.ts`. The max-restarts validate uses `v && (...)` so pressing Enter on an empty input passes through to the `"5"` defaultValue rather than failing validation.
- **Live logs use Server-Sent Events, not WebSockets**: `Process` already emits an `"out"` event (`{ type: "out" | "err", line }`) for every chunk written to its log files. `GET /logs/:getter/stream` subscribes to that event on every matched process and writes `data: {...}\n\n` frames; the listener is removed on `req.on("close")` so a disconnected client doesn't leak listeners on a long-lived `Process`. The client SDK's `streamLogs()` reads the response as a raw Node stream (`responseType: "stream"`, `timeout: 0` to override the instance's 5s default) and splits on `\n\n` itself rather than pulling in an SSE/EventSource dependency. `pd logs <getter> -f` prints history first, then calls `streamLogs()` until Ctrl+C aborts the request.
- **Managed processes are spawned detached and stopped via process-group kill**: `Bun.spawn` is called with `detached: true`, making the child a session/process-group leader (`setsid`). `stop()` signals the whole group with `process.kill(-spawned.pid, "SIGTERM")` instead of `spawned.kill()`. Without this, a managed command that's itself a wrapper (`npm start`, a shell script, `next start`) would only have its wrapper process killed; any real server it forked internally would be reparented to init and keep running (and keep serving traffic) while `pd ls` reported the process as stopped.
- **Action endpoints return the full process list, not just the affected ones**: `start`/`stop`/`restart`/`remove` in `manager.ts` return `{ affected, processes }` where `processes` is a freshly `list()`-ed snapshot (monit included) of every process, and `affected` is the ids the getter actually matched. Previously these returned only the matched `ProcessInfo[]` with stale `monit` (since only `list()` calls `getResourceUsage()`), so `pd restart 1` showed just process 1 with its old PID/CPU/mem instead of the new ones. The CLI renders the full table with a `→` marker on affected rows (`printTable(processes, highlight)` in `cli/index.ts`) instead of a single-row table.
- **Update checks are cached and never block a command**: `cli/update.ts` reads/writes `~/.cache/pd/update-check.json` (`{ checkedAt, latestVersion, releaseUrl }`). A `preAction` Commander hook fires `refreshUpdateCacheIfStale()` without awaiting it (skipped for `update` itself), which only hits the GitHub releases API if the cache is missing or older than 24h, with a 2s abort timeout. A `postAction` hook then prints the nag banner from whatever is cached (no network call), so the banner is always instant and reflects the previous command's background refresh rather than the current one.
- **The package version is the single source of truth**: `package.json`'s `version` field is imported directly into `cli/update.ts` (bundled at compile time, since `bun build --compile` inlines JSON imports) and used both for `pd --version` and for the update-available comparison. Release tags on GitHub aren't strict semver (`dev-1.0.1`); `compareVersions()` strips any non-digit prefix before comparing dotted numeric parts.
- **`pd update` re-runs the install.sh binary-swap logic in-process**: fetches the latest release (with its changelog body, printed before the confirm prompt), downloads `pd-linux-$ARCH`/`pdd-linux-$ARCH` from the `releases/latest/download/` alias, `sudo install`s them over `/usr/local/bin/{pd,pdd}`, then `sudo systemctl restart pdd`. Requires confirmation unless `-y/--yes` is passed, since it overwrites system binaries and restarts a service.

## Log file behavior

Each process run (start/restart) gets its own pair of log files: `<name>-<uuid>-<inc>.out.log` and `.err.log`. Both files begin with a start marker and end with a stop/exit/error marker:

```
-- Process (1) started at 2025-01-01T00:00:00.000Z --
<stdout or stderr output>
-- Process (1) stopped at 2025-01-01T00:01:00.000Z --
```

End verb is `stopped` (manual stop), `exited` (clean exit, code 0), or `errored (code N)` (non-zero exit).

The daemon keeps the last 10 log file pairs per process and deletes older ones automatically after each run ends. `logFiles` (the list of base names) is a getter on `ProcessInfo` and is serialized into `processes.json`, so log history survives daemon restarts.

`GET /logs/:getter?runs=N` returns the last N runs concatenated. `pd logs <getter>` defaults to the last 3 runs; use `--runs N` to override.

## ENV variables

Pass `env` in `ProcessOptions` to inject environment variables into the spawned process. The daemon merges the system environment with the provided values, with user values taking priority:

```ts
const client = new ProcClient();
await client.start({
    name: "my-app",
    cwd: "/path/to/app",
    env: {
        NODE_ENV: "production",
        PORT: "8080",
        DATABASE_URL: "postgres://localhost/mydb",
    },
});
```

From the CLI: `pd start --name my-app --cwd /path/to/app --env NODE_ENV=production PORT=8080`.

## Intentionally excluded

- No authentication (local daemon, trusted network assumed)

## Data on disk

- State: `/var/lib/pdd/processes.json`
- Logs: `/var/lib/pdd/logs/<name>-<uuid>-<inc>.out.log` / `.err.log`
- Only the last 10 log file pairs per process are kept; older ones are deleted after each run.

## Build

```bash
bun run build        # builds SDK (tsup) + all binaries (bun compile)
bun run build:sdk    # SDK only → dist/ (ESM + CJS + .d.ts)
bun run build:server # all binaries → pdd-linux-{x64,arm64}, pd-linux-{x64,arm64}
bun run server       # run daemon in dev (no compile)
bun run cli -- <args> # run CLI in dev (no compile), e.g. bun run cli -- list
```

## CLI (`pd`)

Built with Commander. Entry: `projects/cli/index.ts`.

| Command | Description |
|---------|-------------|
| `pd list` / `pd ls` | Table of all processes with status, CPU, mem, uptime |
| `pd start` | Interactive setup, or auto-detects an ecosystem file in cwd |
| `pd start <name\|id>` | Start a stopped existing process |
| `pd start --name foo --cwd /path [flags]` | Define and start a new process |
| `pd start --efile [path]` | Start all processes from an ecosystem file |
| `pd stop <getter>` | Stop (accepts name, id, or `all`) |
| `pd restart <getter>` | Restart |
| `pd remove <getter>` / `pd rm` | Remove |
| `pd logs <getter> [--out\|--err] [--runs N]` | Show stdout and/or stderr (last 3 runs by default) |
| `pd update [-y\|--yes]` | Update `pd`/`pdd` to the latest GitHub release |

`pd start` flags: `--script`, `--interpreter`, `--restart`, `--max-restarts <n>`, `--env KEY=VALUE`, `--efile [path]`.

Every command checks a 24h-cached local file for a newer release and, if one exists, prints a nag banner after its output pointing at `pd update`. See "Update checks are cached..." above.

## Installation

```bash
# From GitHub release
curl -fsSL https://raw.githubusercontent.com/AirplaneGobrr-Trash/process-daemon/main/install.sh | bash

# From local build (dev)
bash install-local.sh
```

`install-local.sh` runs `bun run build:server`, installs the local binaries, and creates/restarts the systemd service.