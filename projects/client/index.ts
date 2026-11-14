import { readFileSync } from "fs";
import dgram from "node:dgram";
import os from "os";
import type {
    ActionResult,
    BindHost,
    DaemonConfig,
    DaemonConfigWithToken,
    DeployActionResult,
    UpdateStatus,
    DiscoveredDaemon,
    ExecOptions,
    ExecResult,
    FileEntry,
    Getter,
    LogStreamMessage,
    ProcessInfo,
    ProcessOptions,
} from "../types";
export * from "../types";

export interface ProcClientOptions {
    // API token. If omitted and baseURL is a loopback address, it's read from the
    // local daemon's config.json on every request, so a long-lived client keeps
    // working across `pd auth rotate`.
    token?: string;
    // Per-request timeout in ms for regular calls (default 5000). Deploys and
    // log streams never time out.
    timeout?: number;
}

export class ProcClientError extends Error {
    constructor(public status: number, public body: unknown) {
        super(`${status}: ${JSON.stringify(body)}`);
        this.name = "ProcClientError";
    }
}

// Bun's fetch reports a refused connection as `code: "ConnectionRefused"`, Node's
// as a TypeError whose `cause.code` is ECONNREFUSED.
export function isConnectionRefused(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } } | undefined;
    return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || e?.cause?.code === "ECONNREFUSED";
}

export function localConfigPath(): string {
    return `${process.env.PDD_DATA_DIR ?? "/var/lib/pdd"}/config.json`;
}

// Reads the local daemon's token straight from disk. Relies on file permissions
// (config.json is 0600, owned by the user pdd runs as) for access control.
export function readLocalToken(): string | undefined {
    try {
        const token = JSON.parse(readFileSync(localConfigPath(), "utf8")).token;
        return typeof token === "string" ? token : undefined;
    } catch {
        return undefined;
    }
}

// Kept in sync with projects/server/discovery.ts.
const DISCOVER_MAGIC = "pdd-discover-v1";

// Finds pdd daemons on the local network: broadcasts one discovery packet on
// every IPv4 interface (plus 255.255.255.255) and collects replies for
// `timeoutMs`. Only daemons that are `public` and discoverable answer. Each
// result's address/port can be passed straight to `new ProcClient(...)`.
export async function discover(options: { timeoutMs?: number; port?: number } = {}): Promise<DiscoveredDaemon[]> {
    const port = options.port ?? (Number(process.env.PDD_PORT) || 3830);
    const found = new Map<string, DiscoveredDaemon>();
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
        try {
            const info = JSON.parse(msg.toString());
            if (typeof info?.hostname !== "string" || typeof info?.port !== "number") return;
            found.set(`${rinfo.address}:${info.port}`, {
                address: rinfo.address,
                port: info.port,
                hostname: info.hostname,
                version: String(info.version ?? "?"),
                authEnabled: !!info.authEnabled,
            });
        } catch {
            // Not a pdd reply
        }
    });
    await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, () => resolve());
    });
    socket.setBroadcast(true);

    // 255.255.255.255 only leaves through the default route, so also hit each
    // interface's own subnet broadcast address (multi-homed hosts, VLANs).
    const targets = new Set(["255.255.255.255"]);
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.family !== "IPv4" || a.internal) continue;
            const ip = a.address.split(".").map(Number);
            const mask = a.netmask.split(".").map(Number);
            targets.add(ip.map((b, i) => (b | (~mask[i]! & 255))).join("."));
        }
    }
    for (const t of targets) socket.send(DISCOVER_MAGIC, port, t, () => {});

    await new Promise(r => setTimeout(r, options.timeoutMs ?? 1500));
    socket.close();
    return [...found.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class ProcClient {
    private baseURL: string;
    private token?: string;
    private timeout: number;
    private isLocal: boolean;

    // 127.0.0.1, not localhost: pdd binds IPv4 only, and "localhost" can resolve
    // to ::1 first.
    constructor(baseURL = `http://127.0.0.1:${process.env.PDD_PORT || 3830}`, options: ProcClientOptions = {}) {
        this.baseURL = baseURL.replace(/\/+$/, "");
        this.token = options.token;
        this.timeout = options.timeout ?? 5000;
        try {
            this.isLocal = LOOPBACK.has(new URL(this.baseURL).hostname);
        } catch {
            this.isLocal = false;
        }
    }

    private authHeader(): Record<string, string> {
        const token = this.token ?? (this.isLocal ? readLocalToken() : undefined);
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    private async request(method: string, route: string, body?: unknown, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<Response> {
        const timeout = opts.timeout ?? this.timeout;
        const signals = [opts.signal, timeout > 0 ? AbortSignal.timeout(timeout) : undefined].filter(Boolean) as AbortSignal[];
        return fetch(this.baseURL + route, {
            method,
            headers: {
                ...this.authHeader(),
                ...(body !== undefined && { "Content-Type": "application/json" }),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        });
    }

    private async json<T>(res: Response): Promise<T> {
        const text = await res.text();
        let data: unknown = text;
        try {
            data = text ? JSON.parse(text) : undefined;
        } catch {
            // Non-JSON body; keep the raw text for the error message.
        }
        if (!res.ok) throw new ProcClientError(res.status, data);
        return data as T;
    }

    private async get<T>(route: string, timeout?: number): Promise<T> {
        return this.json<T>(await this.request("GET", route, undefined, { timeout }));
    }

    private async post<T>(route: string, body?: unknown, timeout?: number): Promise<T> {
        return this.json<T>(await this.request("POST", route, body, { timeout }));
    }

    async list(): Promise<ProcessInfo[]> {
        return this.get("/list");
    }

    async stop(getter: Getter): Promise<ActionResult> {
        return this.post(`/stop/${getter}`);
    }

    async restart(getter: Getter): Promise<ActionResult> {
        return this.post(`/restart/${getter}`);
    }

    async remove(getter: Getter): Promise<ActionResult> {
        return this.post(`/remove/${getter}`);
    }

    async start(config: ProcessOptions): Promise<ActionResult>
    async start(getter: Getter): Promise<ActionResult>
    async start(config: ProcessOptions | Getter): Promise<ActionResult> {
        if (typeof config === "number" || typeof config === "string") {
            return this.post(`/start/${config}`);
        }
        // A git-backed start clones and builds before spawning, which can take minutes.
        return this.post("/start", config, config.git ? 0 : undefined);
    }

    // Fetches + hard-resets (or clones) each matched git-backed process, runs its
    // build commands, and restarts it if the commit changed. `force` rebuilds and
    // restarts even when already up to date. Never times out.
    async deploy(getter: Getter, options?: { force?: boolean }): Promise<DeployActionResult> {
        return this.post(`/deploy/${getter}`, { force: !!options?.force }, 0);
    }

    // Merges (or, with `replace`, fully replaces) a process's env vars. Restarts the
    // process to apply the change immediately if it's currently running.
    async setEnv(getter: Getter, env: Record<string, string>, options?: { replace?: boolean }): Promise<ActionResult> {
        return this.post(`/env/${getter}`, { env, replace: options?.replace });
    }

    // Patches a process's stored options (any subset of ProcessOptions; `env` here
    // replaces the whole map). Restarts the process if it's currently running.
    async setConfig(getter: Getter, patch: Partial<ProcessOptions>): Promise<ActionResult> {
        return this.post(`/config/${getter}`, patch);
    }

    async logs(getter: Getter, options?: { runs?: number }): Promise<{ out: string, err: string }> {
        const qs = options?.runs !== undefined ? `?runs=${options.runs}` : "";
        return this.get(`/logs/${getter}${qs}`);
    }

    // ── Files (inside a process's cwd; `path` is relative to it) ─────────────

    async listFiles(getter: Getter, path = ""): Promise<FileEntry[]> {
        return this.get(`/files/${encodeURIComponent(String(getter))}?path=${encodeURIComponent(path)}`);
    }

    // Text files up to 2MB; binary files are refused.
    async readFile(getter: Getter, path: string): Promise<{ content: string; size: number }> {
        return this.get(`/file/${encodeURIComponent(String(getter))}?path=${encodeURIComponent(path)}`);
    }

    // Creates or replaces the file (atomically). The parent directory must exist.
    async writeFile(getter: Getter, path: string, content: string): Promise<{ size: number; created: boolean }> {
        return this.json(await this.request("PUT", `/file/${encodeURIComponent(String(getter))}?path=${encodeURIComponent(path)}`, { content }));
    }

    // Runs one shell command on the daemon's machine and returns its output.
    // Waits for the command (up to its timeout, default 60s, max 10 min).
    async exec(options: ExecOptions): Promise<ExecResult> {
        const limit = Math.min(options.timeoutMs ?? 60_000, 600_000);
        return this.post("/exec", options, limit + 10_000);
    }

    // ── Self-update ──────────────────────────────────────────────────────────

    async getUpdateStatus(options?: { check?: boolean }): Promise<UpdateStatus> {
        return this.get(`/daemon/update${options?.check ? "?check=1" : ""}`, 20_000);
    }

    // Installs the latest signed release and restarts the daemon into it.
    // `started: false` with a reason when there's nothing to do or it can't.
    async updateDaemon(options?: { force?: boolean }): Promise<{ started: boolean; from: string; to?: string; reason?: string; error?: string }> {
        const res = await this.request("POST", "/daemon/update", { force: !!options?.force }, { timeout: 5 * 60_000 });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok && res.status !== 502) throw new ProcClientError(res.status, data);
        return data;
    }

    async setAutoUpdate(enabled: boolean): Promise<DaemonConfig> {
        return this.post("/daemon/auto-update", { enabled });
    }

    // ── Daemon settings ──────────────────────────────────────────────────────

    async getDaemonConfig(): Promise<DaemonConfig> {
        return this.get("/daemon");
    }

    async setAuthEnabled(enabled: boolean): Promise<DaemonConfig> {
        return this.post("/daemon/auth", { enabled });
    }

    // Whether this daemon answers discover() broadcasts (only while public).
    async setDiscoverable(enabled: boolean): Promise<DaemonConfig> {
        return this.post("/daemon/discoverable", { enabled });
    }

    // Returns the new token. An explicitly configured client switches to it so it
    // keeps working; a local one picks it up from config.json anyway.
    async rotateToken(): Promise<DaemonConfigWithToken> {
        const result = await this.post<DaemonConfigWithToken>("/daemon/token/rotate");
        if (this.token) this.token = result.token;
        return result;
    }

    // "local" = 127.0.0.1, "public" = 0.0.0.0. The daemon rebinds right after
    // answering, so the next request may briefly see a refused connection.
    async setHost(host: "local" | "public" | BindHost): Promise<DaemonConfig> {
        const resolved = host === "local" ? "127.0.0.1" : host === "public" ? "0.0.0.0" : host;
        return this.post("/daemon/host", { host: resolved });
    }

    // Streams live stdout/stderr as it's produced, until the process exits, the
    // server closes the connection, or `signal` is aborted. Resolves once streaming ends.
    async streamLogs(getter: Getter, onMessage: (msg: LogStreamMessage) => void, signal?: AbortSignal): Promise<void> {
        const res = await this.request("GET", `/logs/${getter}/stream`, undefined, { timeout: 0, signal });
        if (!res.ok || !res.body) {
            await this.json(res);
            return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLine = raw.split("\n").find(l => l.startsWith("data: "));
                if (!dataLine) continue;
                try {
                    onMessage(JSON.parse(dataLine.slice("data: ".length)) as LogStreamMessage);
                } catch {
                    // Ignore malformed frames
                }
            }
        }
    }
}
