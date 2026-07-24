import axios, { type AxiosInstance } from "axios";
import type { ActionResult, Getter, LogStreamMessage, ProcessInfo, ProcessOptions } from "../types";
export * from "../types";

export class ProcClient {
    private http: AxiosInstance;

    constructor(baseURL = "http://localhost:3830") {
        this.http = axios.create({
            baseURL,
            timeout: 5000,
            validateStatus: () => true
        });
    }

    private async get<T>(route: string): Promise<T> {
        const res = await this.http.get(route);
        if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.data)}`);
        return res.data as T;
    }

    private async post<T>(route: string, body?: unknown): Promise<T> {
        const res = await this.http.post(route, body);
        if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.data)}`);
        return res.data as T;
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
        return this.post("/start", config);
    }

    // Merges (or, with `replace`, fully replaces) a process's env vars. Restarts the
    // process to apply the change immediately if it's currently running.
    async setEnv(getter: Getter, env: Record<string, string>, options?: { replace?: boolean }): Promise<ActionResult> {
        return this.post(`/env/${getter}`, { env, replace: options?.replace });
    }

    async logs(getter: Getter, options?: { runs?: number }): Promise<{ out: string, err: string }> {
        const qs = options?.runs !== undefined ? `?runs=${options.runs}` : "";
        return this.get(`/logs/${getter}${qs}`);
    }

    // Streams live stdout/stderr as it's produced, until the process exits, the
    // server closes the connection, or `signal` is aborted. Resolves once streaming ends.
    async streamLogs(getter: Getter, onMessage: (msg: LogStreamMessage) => void, signal?: AbortSignal): Promise<void> {
        const res = await this.http.get(`/logs/${getter}/stream`, {
            responseType: "stream",
            timeout: 0,
            signal,
        });

        const stream = res.data as NodeJS.ReadableStream;

        if (res.status >= 400) {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            throw new Error(`${res.status}: ${Buffer.concat(chunks).toString()}`);
        }

        let buffer = "";
        for await (const chunk of stream) {
            buffer += chunk.toString();
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
