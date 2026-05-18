import axios, { type AxiosInstance } from "axios";
import type { Getter, ProcessInfo, ProcessOptions } from "../types";
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

    async stop(getter: Getter): Promise<ProcessInfo[]> {
        return this.post(`/stop/${getter}`);
    }

    async restart(getter: Getter): Promise<ProcessInfo[]> {
        return this.post(`/restart/${getter}`);
    }

    async remove(getter: Getter): Promise<ProcessInfo[]> {
        return this.post(`/remove/${getter}`);
    }

    async start(config: ProcessOptions): Promise<ProcessInfo[]>
    async start(getter: Getter): Promise<ProcessInfo[]>
    async start(config: ProcessOptions | Getter): Promise<ProcessInfo[]> {
        if (typeof config === "number" || typeof config === "string") {
            return this.post(`/start/${config}`);
        }
        return this.post("/start", config);
    }

    async logs(getter: Getter): Promise<{ out: string, err: string }> {
        return this.get(`/logs/${getter}`);
    }
}
