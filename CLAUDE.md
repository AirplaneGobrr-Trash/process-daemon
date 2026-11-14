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
    dashboard.html: web UI served at GET /, inlined into the pdd binary
    manager.ts    : in-memory process list, persistence, actions
    process.ts    : child process lifecycle (spawn, log, restart)
    deploy.ts     : git clone/fetch + build + rollback for git-backed processes
    config.ts     : daemon settings (config.json: token, auth, bind host, discovery)
    discovery.ts  : UDP responder for `pd discover`
  client/
    index.ts      : ProcClient SDK (native fetch) + discover()
  cli/
    index.ts      : pd CLI (Commander, uses ProcClient)
    update.ts     : version comparison, cached update-check, self-update install
  types.ts        : shared types across all components
```

The server exposes an HTTP API on `:3830`. The client SDK and CLI both talk to it. The daemon is the only thing that directly manages processes.

## HTTP API

| Method | Route              | Description                        |
|--------|--------------------|------------------------------------|
| GET    | `/`                | Web dashboard (single static HTML page) |
| GET    | `/list`            | List all processes with monit data |
| POST   | `/start`           | Start a new process (body: ProcessOptions), returns `ActionResult` |
| POST   | `/start/:getter`   | Start an existing stopped process, returns `ActionResult` |
| POST   | `/stop/:getter`    | Stop a process, returns `ActionResult`     |
| POST   | `/restart/:getter` | Restart a process, returns `ActionResult`  |
| POST   | `/remove/:getter`  | Stop and remove a process, returns `ActionResult` |
| POST   | `/env/:getter`     | Update env vars for a process (body: `{ env, replace? }`), returns `ActionResult` |
| POST   | `/config/:getter`  | Patch stored process options (body: any subset of `ProcessOptions`; `env` replaces the whole map), returns `ActionResult` |
| POST   | `/deploy/:getter`  | Clone/fetch + build + restart git-backed processes (body: `{ force? }`), returns `DeployActionResult` |
| GET    | `/daemon`          | Daemon settings `{ authEnabled, host, discoverable }` (never the token) |
| POST   | `/daemon/auth`     | `{ enabled }` turns token auth on/off |
| POST   | `/daemon/host`     | `{ host: "127.0.0.1" \| "0.0.0.0" }`, rebinds the listener in place after responding |
| POST   | `/daemon/discoverable` | `{ enabled }` toggles answering discovery broadcasts |
| POST   | `/daemon/token/rotate` | Generates a new token, returns it |
| POST   | `/exec`            | Run one shell command (`sh -c`), body `{ command, getter?, cwd?, timeoutMs? }`. With `getter`: that process's cwd + env. Default cwd is the daemon user's home, timeout 60s (max 10 min). Returns `ExecResult` |
| GET    | `/daemon/update`   | Self-update status (`UpdateStatus`); `?check=1` asks GitHub for the latest release first |
| POST   | `/daemon/update`   | Install the latest signed release and restart into it (body `{ force? }`). Answers 202 `{ started, from, to }` before restarting |
| POST   | `/daemon/auto-update` | `{ enabled }` toggles automatic updates (default on, checked every 6h) |
| GET    | `/files/:getter`   | List a directory inside the process's cwd (`?path=` relative to it), returns `FileEntry[]`. Getter must match exactly one process |
| GET    | `/file/:getter`    | Read a text file inside the process's cwd (`?path=`), returns `{ content, size }`. 2MB cap, binary refused (415) |
| PUT    | `/file/:getter`    | Create or replace a text file inside the process's cwd (`?path=`, body `{ content }`), atomic tmp + rename, keeps the mode. 5MB cap |
| GET    | `/logs/:getter`    | Returns `{ out: string, err: string }`. Optional `?runs=N` limits to the last N runs. |
| GET    | `/logs/:getter/stream` | Server-Sent Events stream of live stdout/stderr lines as they're produced, as `{ id, type: "out" \| "err", line }` frames. Matches every process the getter resolves to (including `"all"`). |

Mutations are POST. Always returns JSON. While auth is enabled (the default) every route except the dashboard page (`GET /`) requires `Authorization: Bearer <token>`; GETs also accept `?token=` because the dashboard's `EventSource` can't set headers. Unauthenticated requests get `401`.

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
    lastError?: string;    // set on pre-flight failure, max restarts exceeded, or a failed pid reclaim on respawn
    pid?: number;          // captured at spawn time, independent of monit
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
- **Processes.json is recovered gracefully**: `respawn()` wraps JSON parse in try/catch and defaults to `[]` on corrupt/empty file, but logs loudly to stderr first since this means total loss of process tracking, so it's visible in `journalctl` instead of silently eating every managed process.
- **`save()` writes atomically**: writes to `processes.json.tmp` in the same directory, then `rename()`s it over `processes.json`. `rename()` is atomic on the same filesystem, so a daemon kill (OOM, `kill -9`, host reboot) mid-write can never leave a truncated/corrupt file behind.
- **`killOrphan()` escalates to SIGKILL**: after the existing 10x200ms SIGTERM wait, if the pid is still alive it sends SIGKILL to the process group and waits again, returning whether the pid is actually dead by the end. `Process.stop()` mirrors this: SIGTERM, wait up to 5s via `Promise.race` against `spawned.exited`, then SIGKILL and wait up to 2s more if it's still alive. Neither ever hangs indefinitely on an unresponsive child. This deliberately doesn't change the process-group (`-pid`) targeting itself; a script that further detaches its own grandchild still escapes it, a known limitation out of scope here.
- **`respawn()` refuses to double-spawn over an unreclaimed pid**: if `killOrphan()` reports the old pid is still alive after SIGKILL (e.g. it's in an uninterruptible state, or belongs to a process we don't have permission to signal), the entry is left in `Status.Error` with `lastError` set to `could not reclaim pid <n>, refusing to double-spawn` instead of spawning a replacement that might collide with the still-running orphan (e.g. over the same port). See "Troubleshooting" below.
- **`pid` is captured independently of `monit`**: `Process.pid` is set from `Bun.spawn()`'s return value the moment it resolves, not derived from the async, pidusage-populated `monit.pid`. This lets `processes.json` always serialize the real pid, even for a process whose first resource-usage poll hasn't completed (or never succeeds) yet. `respawn()` falls back to the old `monit.pid` field when reading a `processes.json` written before this field existed.
- **Every spawn persists, not just route-driven actions**: `Process` emits a `"spawned"` event every time `start()` successfully spawns a child, including the internal auto-restart path (`onExit`'s `setTimeout(() => that.start(true), ...)`), which previously never notified `manager.ts`. `createProcess()` subscribes to `"spawned"` and calls `save()`, so `processes.json` always reflects the live pid across auto-restarts that never touched an HTTP route.
- **`start()` refuses to double-spawn over its own still-running child**: the guard used to check `this.spawned && !this.spawned.exited`, but `exited` is a `Promise` (always truthy), so the check never actually fired; it now checks `this.spawned.exitCode === null`. A `_starting` flag, set synchronously before the interpreter/cwd/script preflight `await`s, closes the remaining window where a second call (a manual restart racing a pending auto-restart `setTimeout`) could land before `this.spawned` is assigned and slip past that guard too. Without both, two overlapping `start()` calls (e.g. from a mass-SIGTERM restart storm, like every managed process dying at once from `pkill bun` since they're all spawned via the `bun` interpreter) could spawn a second child on top of a healthy first one; whichever child's `onExit` fires afterward unconditionally overwrites `status`/`lastError`/`restartCount`, leaving the daemon reporting a stale/errored state for a process whose real child is alive and fine.
- **Log write failures are attributed to their process, not left uncaught**: `outStream`/`errStream` in `start()` have an `"error"` listener that logs via `console.error` tagged with the process id. Without it, a write failure (e.g. `ENOSPC`) surfaces as a bare uncaught exception on the daemon's top-level handler with no indication of which process's logs failed.
- **Singleton guard via pidfile**: `server.ts` checks `./pdd.pid` (`/var/lib/pdd/pdd.pid` in production, since that's the service's `WorkingDirectory`) before binding port 3830. If it exists and that pid is still alive, the daemon refuses to start instead of racing another live instance over `processes.json` and the port. The pidfile is removed on graceful shutdown so a later, unrelated process reusing that pid can't falsely trip the check.
- **CLI auto-starts the daemon**: every `pd` command calls `ensureDaemon()` first; on `ECONNREFUSED` it writes `/var/lib/pdd/env` with the current bun PATH, then runs `sudo systemctl start pdd` and polls until `:3830` responds.
- **Interpreter is resolved to an absolute path**: `resolveInterpreter()` in `process.ts` tries `Bun.which` first, then falls back to known install locations (`~/.bun/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`). The resolved path is passed directly to `Bun.spawn`, so systemd's stripped PATH never causes a "No interpreter" error.
- **Bun PATH is written by the CLI, not hardcoded in the service**: `ensureDaemon()` writes `PATH=<bun-dir>:...` to `/var/lib/pdd/env` before starting the service. The service file uses `EnvironmentFile=-/var/lib/pdd/env` (the `-` means the file is optional, so cold starts without a prior `pd` invocation still work via `resolveInterpreter`'s fallback).
- **`pd list` shows ERROR column only when needed**: the column is omitted when no process has a `lastError`, keeping normal output clean. When present, errors are shown in red.
- **Ecosystem files are PM2-compatible**: `pd start` auto-detects `ecosystem.config.js`, `ecosystem.config.cjs`, `ecosystem.config.json`, or `ecosystem.json` in cwd. `--efile [path]` overrides the path. PM2 field names (`autorestart`, `max_restarts`) are normalized to the native ones on load. The save path (after interactive creation) always writes PM2-compatible JSON (`{ apps: [...] }`). JS/CJS files are loaded via dynamic `import()`. `cwd` in an ecosystem file is relative to the file's own directory (missing means the file's directory), and the CLI resolves it to an absolute path before sending it, since the daemon runs from `/var/lib/pdd`. Saving writes `cwd` back relative to the file (`"."` when it's the same directory), so the file stays portable. `--cwd` and the interactive prompt are also resolved against the shell's cwd.
- **`_stopping` is never reset inside `stop()`**: it is only cleared at the top of a manual `start()` call (`isAutoRestart = false`). This prevents a race where `onExit` fires as a separate microtask after `await exited` resolves but before `_stopping` was (previously) reset to `false`, and also stops any pending `setTimeout` auto-restart from firing after a manual stop (`start(true)` returns immediately when `_stopping` is set).
- **`getResourceUsage` guards against ESRCH**: checks `spawned.exitCode !== null` before calling `pidusage`, and wraps the call in try/catch to handle the narrow race where the process exits between the check and the pidusage call. Without this, `pd list` would 500 whenever any process was stopped.
- **Interactive path prompts use readline tab completion**: `cwd`, `script`, and ecosystem file path prompts bypass `@clack/prompts` (which has no completer hook) and use a `readline.createInterface` with a custom `completer`. The script completer receives the entered `cwd` as `baseCwd` so it resolves relative paths against that directory for the filesystem read, but returns completions as relative paths so the user types `src/index.ts` not `/srv/api/src/index.ts`. The max-restarts validate uses `v && (...)` so pressing Enter on an empty input passes through to the `"5"` defaultValue rather than failing validation.
- **Auth is a single bearer token in `config.json`, on by default**: `config.ts` loads `./config.json` (`/var/lib/pdd/config.json` in production, 0600) on boot, generating a 32-byte hex token and defaulting to `authEnabled: true`, `host: "127.0.0.1"` if it's missing; it's saved immediately so local tools can read the token before the first request. Secure defaults because anything that reaches the API can run arbitrary commands (`POST /start` takes any interpreter, `build` takes any shell command). The check runs per request against the live config (constant-time compare), so `pd auth enable/disable/rotate` take effect without a restart. Local clients never need the token passed in: `ProcClient` re-reads it from `$PDD_DATA_DIR/config.json` (default `/var/lib/pdd`) on every request when its baseURL is loopback, so long-lived local users like auto-deploy survive a rotate. The token is only ever returned over the API by `rotate`; `pd auth token` reads the file directly.
- **Bind address switches in place, without a restart**: `POST /daemon/host` saves the new host, responds, then on `res.on("finish")` closes the old listener (`closeAllConnections()`, which drops open SSE streams) and listens on the new one, retrying on `EADDRINUSE`. If the new address can't be bound it falls back to the previous one and reverts config; if neither binds it exits non-zero so systemd's `Restart=on-failure` brings it back. `public` is `0.0.0.0` (IPv4 only), so the SDK defaults to `http://127.0.0.1:3830`, not `localhost` (which can resolve to `::1`).
- **Discovery is UDP request/response, not a beacon**: `discovery.ts` binds UDP on the same port number as the API and answers the exact payload `pdd-discover-v1` with `{ port, hostname, version, authEnabled }` (never the token). It only answers while `discoverable` (default on) and `host` is `0.0.0.0`, since a loopback-only daemon isn't reachable by the asker anyway. The SDK's `discover()` broadcasts once to `255.255.255.255` plus every IPv4 interface's subnet broadcast address and collects replies for 1.5s. Nothing is sent on the network unless someone is actively looking. Chosen over mDNS to avoid a dependency and fighting avahi over port 5353.
- **Self-update without root, with signatures and rollback**: `install.sh` (the one step that needs sudo) puts the binaries in `/var/lib/pdd/bin` (owned by the pdd user), makes `/usr/local/bin/{pd,pdd}` symlinks to them, and runs pdd through `bin/pdd-launch` with `Restart=always` and no start limit. `projects/release.ts` is shared by the daemon (`server/selfupdate.ts`) and `pd update`: it downloads a release by tag, verifies `SHA256SUMS.sig` (Ed25519) against `RELEASE_PUBLIC_KEY`, checks each `.gz` against `SHA256SUMS`, then installs with the current binaries kept as `*.prev` and an `update-pending` marker. The daemon restarts by shutting down cleanly and exiting 75. The launcher counts starts while `update-pending` exists and, on the 4th, puts `*.prev` back and writes `update-rollback`; plain sh, so it works even if the new binary can't execute. A daemon that stays up 60s clears the marker and records `last-update.json`. Auto-update never retries a version that was rolled back on that node (a manual update can). `canSelfUpdate` is false until the layout is in place (old installs, dev runs), and `pd update` then does the one-time migration with sudo. `release.ts` (root) refuses to publish without the private key (`~/.config/pdd-release/signing-key.pem` or `PDD_SIGNING_KEY`) and checks it matches the embedded public key. `PDD_RELEASE_API` / `PDD_RELEASE_DOWNLOAD` point updates at a test mirror; the signature check still applies.
- **`POST /exec` is the same trust level as `POST /start`**: anything holding the token can already run any interpreter, so a one-off command endpoint adds convenience, not access. Output is capped at 256KB per stream (keeps the tail), and the command runs in its own process group so the timeout kill takes its children too.
- **File access is confined to the process's cwd, symlinks included**: `files.ts` resolves `?path=` with `realpath` against the realpath of the cwd and refuses anything outside it (`..`, or a symlink pointing out), so a tool editing a `.env` can't wander into the rest of the machine by accident. This is a guard rail, not a security boundary: anything that can call the API can already run commands via `POST /start`. Writes go to a tmp file then `rename`, so an app never reads a half-written config. The global JSON body limit is 12MB to fit a 5MB file after escaping.
- **Git deploys hard-reset, never pull, and roll back a failed build**: a process with `git: { repo, branch? }` (+ optional `build: string[]`) is deployed by `deploy.ts`. Missing/empty `cwd` is cloned (`--single-branch`); a non-empty non-git `cwd` is refused; an existing checkout gets `git remote set-url origin` (so a repo change applies), `git fetch origin <branch>`, then `git reset --hard FETCH_HEAD`. `reset --hard` instead of `pull` so local edits or a force-push can never wedge a node on a merge conflict; untracked files (`.env`, sqlite dbs, uploads) are left alone, no `git clean`. If the fetched commit equals HEAD it's a no-op unless `force`. Build commands run via `sh -c` in `cwd` with the process's env. If one fails, the checkout is reset to the previous commit and the build re-run, so a later crash-restart doesn't load half-built new code; the running process is never touched on failure, and `lastError` is set to `deploy failed: ...`. On success the manager restarts the process if it was `online`/`starting`/`error` (a stopped one stays stopped). Every command has a 10 minute timeout (process-group SIGKILL), runs with `GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes` so it can never hang on a prompt, and is tracked by a per-process `deploying` lock (overlapping deploys get an error result). Output is streamed through the process's `"out"` event (so `pd logs -f` shows it live) and returned, tail-capped at 256KB, in `DeployResult.output`; credentials in clone URLs are redacted from output and errors (but are still stored in `startOptions.git.repo`). `POST /start` with `git` deploys before the first spawn; if that fails the process is left in `Error` with no `lastAction`, so `respawn()` doesn't retry a broken checkout on every boot. `commit` and `lastDeploy` are getters on `ProcessInfo`, persisted to `processes.json`. Credentials are the node's own git setup (deploy key / credential helper); pdd stores none. Deciding *when* to deploy (webhooks, polling) is left to the caller, e.g. auto-deploy.
- **An unconfigured process can adopt its existing checkout, but only when named explicitly**: `pd deploy <name>` on a process with no `git` config whose `cwd` is already a git checkout reads `git remote get-url origin` and the current branch, and saves them to `startOptions.git` once the deploy succeeds (a failed first attempt leaves the process unconverted). Because every deploy is a `reset --hard`, adoption refuses a checkout with uncommitted changes to tracked files (`git status --porcelain --untracked-files=no`) unless `force`, and refuses a detached HEAD. `deploy("all")` never infers (`inferGit` is only passed for a non-`all` getter), so it can't start hard-resetting checkouts nobody opted in.
- **Live logs use Server-Sent Events, not WebSockets**: `Process` already emits an `"out"` event (`{ type: "out" | "err", line }`) for every chunk written to its log files. `GET /logs/:getter/stream` subscribes to that event on every matched process and writes `data: {...}\n\n` frames; the listener is removed on `req.on("close")` so a disconnected client doesn't leak listeners on a long-lived `Process`. The client SDK's `streamLogs()` reads the `fetch` response body as a stream (no timeout, unlike the 5s default for other calls) and splits on `\n\n` itself rather than pulling in an SSE/EventSource dependency. `pd logs <getter> -f` prints history first, then calls `streamLogs()` until Ctrl+C aborts the request.
- **Managed processes are spawned detached and stopped via process-group kill**: `Bun.spawn` is called with `detached: true`, making the child a session/process-group leader (`setsid`). `stop()` signals the whole group with `process.kill(-spawned.pid, "SIGTERM")` instead of `spawned.kill()`. Without this, a managed command that's itself a wrapper (`npm start`, a shell script, `next start`) would only have its wrapper process killed; any real server it forked internally would be reparented to init and keep running (and keep serving traffic) while `pd ls` reported the process as stopped.
- **Env vars are updated in place, not by recreating the process**: `POST /env/:getter` (`ProcClient.setEnv()`, `pd env <getter> KEY=VALUE...`) merges the given vars into `info.env` on the matching `Process`(es) by default, or fully replaces it with `--replace`/`{ replace: true }`. Since env is only read at spawn time, a process that's currently `online`/`starting` is restarted immediately so the change takes effect; a stopped process just has its stored options updated for the next `start()`. The merged/replaced env is written back to `startOptions.env` on the `ProcessInfo` so it persists to `processes.json` and survives a daemon restart.
- **Config is edited in place, same as env**: `POST /config/:getter` (`ProcClient.setConfig()`, the dashboard's per-row Edit form) patches `name`/`cwd`/`script`/`interpreter`/`restart`/`maxRestarts`/`env` on the `Process` (`setOptions()`, which reapplies the `script: "."` / `interpreter: "bun"` defaults) and on `startOptions`, so it persists to `processes.json`. Unknown keys are dropped and each field is type-checked in `server.ts` (`parseConfigPatch`). A running process is restarted to apply the change; a stopped one keeps it for its next `start()`.
- **Action endpoints return the full process list, not just the affected ones**: `start`/`stop`/`restart`/`remove` in `manager.ts` return `{ affected, processes }` where `processes` is a freshly `list()`-ed snapshot (monit included) of every process, and `affected` is the ids the getter actually matched. Previously these returned only the matched `ProcessInfo[]` with stale `monit` (since only `list()` calls `getResourceUsage()`), so `pd restart 1` showed just process 1 with its old PID/CPU/mem instead of the new ones. The CLI renders the full table with a `→` marker on affected rows (`printTable(processes, highlight)` in `cli/index.ts`) instead of a single-row table.
- **Update checks are cached and never block a command**: `cli/update.ts` reads/writes `~/.cache/pd/update-check.json` (`{ checkedAt, latestVersion, releaseUrl }`). A `preAction` Commander hook fires `refreshUpdateCacheIfStale()` without awaiting it (skipped for `update` itself), which only hits the GitHub releases API if the cache is missing or older than 24h, with a 2s abort timeout. A `postAction` hook then prints the nag banner from whatever is cached (no network call), so the banner is always instant and reflects the previous command's background refresh rather than the current one.
- **The package version is the single source of truth**: `package.json`'s `version` field is imported directly into `cli/update.ts` (bundled at compile time, since `bun build --compile` inlines JSON imports) and used both for `pd --version` and for the update-available comparison. Release tags on GitHub aren't strict semver (`dev-1.0.1`); `compareVersions()` strips any non-digit prefix before comparing dotted numeric parts.
- **`pd update` re-runs the install.sh binary-swap logic in-process**: fetches the latest release (with its changelog body, printed before the confirm prompt), downloads `pd-linux-$ARCH`/`pdd-linux-$ARCH` from the `releases/latest/download/` alias, `sudo install`s them over `/usr/local/bin/{pd,pdd}`, then `sudo systemctl restart pdd`. Requires confirmation unless `-y/--yes` is passed, since it overwrites system binaries and restarts a service.
- **The web dashboard is one static file, not a second server**: `projects/server/dashboard.html` is plain HTML/CSS/JS with no build step or framework, imported into `server.ts` with `with { type: "text" }` so `bun build --compile` inlines it into `pdd`, and served at `GET /` on the same `:3830` port. It only uses the existing API: polls `/list` every 2s (paused while the tab is hidden), calls `POST /start|stop|restart/:id` for the row buttons, `POST /config/:id` for the Edit form, and on row click shows `/logs/:id?runs=1` followed by a live `EventSource` on `/logs/:id/stream`. Log output is capped at 2000 lines in the page. The page itself is served without auth; its API calls go through a `window.fetch` wrapper that sends the token from `localStorage` (prompting for it once on the first 401), and the log `EventSource` passes it as `?token=`. `PDD_PORT` overrides the listen port (and the SDK/CLI default port), for running a test daemon next to the real one, with `PDD_DATA_DIR` pointing `pd` at that daemon's directory so it finds its token.
- **Release assets are gzipped, not raw binaries**: `bun build --compile` embeds the whole Bun runtime, so each of the four binaries is ~90MB regardless of app code size (confirmed: minify and strip each save well under 1MB, not worth it). `build.ts` gzips every binary after compiling (`pdd-linux-$ARCH.gz`, `pd-linux-$ARCH.gz`, ~62% smaller), and those `.gz` files are what get uploaded to the GitHub release, not the raw binaries. `install.sh` and `cli/update.ts`'s `downloadAsset()` both fetch the `.gz` variant and decompress it (`gunzip` / `Bun.gunzipSync`) before installing.

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

## Troubleshooting

- **`lastError: could not reclaim pid <n>, refusing to double-spawn`**: seen on daemon startup (`respawn()`) when a process from a previous run was still alive under its last known pid and survived both a SIGTERM and a follow-up SIGKILL. The daemon refuses to spawn a replacement since the old one might still hold the port or other resources. The process is left in `Status.Error` for manual intervention: confirm whether pid `<n>` is still running (`ps -p <n>`), deal with it manually if so (it's likely wedged in an uninterruptible state, or owned by a different user), then `pd restart <getter>` once it's actually gone.

## Intentionally excluded

- No users/roles: one token grants full access.

## Data on disk

- State: `/var/lib/pdd/processes.json`
- Settings + API token: `/var/lib/pdd/config.json` (0600, gitignored in dev)
- Logs: `/var/lib/pdd/logs/<name>-<uuid>-<inc>.out.log` / `.err.log`
- Only the last 10 log file pairs per process are kept; older ones are deleted after each run.

## Build

```bash
bun run build        # builds SDK (tsup) + all binaries (bun compile)
bun run build:sdk    # SDK only → dist/ (ESM + CJS + .d.ts)
bun run build:server # all binaries → pdd-linux-{x64,arm64}, pd-linux-{x64,arm64}
bun run server       # run daemon in dev (no compile)
bun run cli -- <args> # run CLI in dev (no compile), e.g. bun run cli -- list
bun run test         # runs projects/server/test.ts (bun:test)
```

## Release

`release.ts` (root) publishes a GitHub release from a `Release.md` file via `gh release create`.

`Release.md` format:

```
title: Version 1.0.0
version: v1.0.0
Initial release description
```

- First line starting with `title:` becomes the release title (prefix stripped, trimmed).
- First line starting with `version:` becomes the release tag (prefix stripped, trimmed, keep the `v`).
- Every other line becomes the release notes body, in order.

Run it with:

```bash
bun run release.ts                    # Release.md + the four {pd,pdd}-linux-{x64,arm64}.gz binaries
bun run release.ts Release.md a.gz b.gz # explicit notes file and asset paths
bun run release                       # package.json script, same defaults as above
```

- The release tag's numeric part must match `package.json`'s `version` (`dev-1.3.0` ↔ `1.3.0`), or the script refuses to publish, since `pd update` compares against the package version.
- With the default assets, the script runs `bun run build:server` first, so the uploaded `.gz` files are always freshly built from the current tree. Explicit asset paths are uploaded as given, with no build.

When the user asks to "make a release note" / "make a release", write or update `Release.md` in this format, then run `release.ts`. Since `gh release create` publishes a real GitHub release, confirm the title/version/notes and the asset path with the user before running it.

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
| `pd env <getter> KEY=VALUE...` | Update env vars (merges by default; `--replace` to overwrite); restarts the process if it's running |
| `pd logs <getter> [--out\|--err] [--runs N]` | Show stdout and/or stderr (last 3 runs by default) |
| `pd update [-y\|--yes]` | Update `pd`/`pdd` to the latest GitHub release |
| `pd deploy <getter> [-f] [-v]` | Clone/fetch + build + restart git-backed processes; `-f` forces even if up to date, `-v` prints output on success too. Exits 1 if any deploy failed |
| `pd auth token\|status\|enable\|disable\|rotate` | Print the token (read from config.json), show settings, toggle auth, or rotate the token |
| `pd server [local\|public\|status]` | Show or set the bind address (127.0.0.1 / 0.0.0.0) |
| `pd server broadcast on\|off` | Toggle answering `pd discover` |
| `pd discover [-t ms]` | List pdd daemons on the LAN that are public with broadcast on |
| `pd config` | Interactive menu for the daemon settings above |

`pd start` flags: `--script`, `--interpreter`, `--restart`, `--max-restarts <n>`, `--env KEY=VALUE`, `--git <repo>`, `--branch <branch>`, `--build <cmd...>`, `--efile [path]`. Ecosystem files accept `repo`, `branch`, and `build` (or PM2's `post_update`) per app.

Every command checks a 24h-cached local file for a newer release and, if one exists, prints a nag banner after its output pointing at `pd update`. See "Update checks are cached..." above.

## Installation

```bash
# From GitHub release
curl -fsSL https://raw.githubusercontent.com/AirplaneGobrr-Trash/process-daemon/main/install.sh | bash

# From local build (dev)
bash install-local.sh
```

`install-local.sh` runs `bun run build:server`, installs the local binaries, and creates/restarts the systemd service.