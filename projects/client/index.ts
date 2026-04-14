import axios, { type AxiosInstance } from "axios";
import type { Getter, ProcessInfo, ProcessOptions, Actions } from "../types";
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

    async doAction(action: Actions | "list", getter?: Getter): Promise<ProcessInfo[]> {
        let route = `/${action}`
        if (getter) {
            route += `/${getter}`;
        }

        const res = await this.http.get(route);
        const data = res.data as ProcessInfo[];
        return data;
    }

    async stop(getter: Getter): Promise<ProcessInfo[]> {
        return await this.doAction("stop", getter);
    }

    async remove(getter: Getter): Promise<ProcessInfo[]> {
        return await this.doAction("remove", getter);
    }

    async restart(getter: Getter): Promise<ProcessInfo[]> {
        return await this.doAction("restart", getter);
    }

    async list(): Promise<ProcessInfo[]> {
        return await this.doAction("list");
    }


    /** POST /start */
    async start(config: ProcessOptions): Promise<ProcessInfo[]>
    async start(getter: Getter): Promise<ProcessInfo[]>

    /** POST /start */
    async start(config: ProcessOptions | Getter): Promise<ProcessInfo[]> {
        if (typeof config === "number" || typeof config === "string") {
            return await this.doAction("start", config);
        }
        const res = await this.http.post("/start", config);
        return res.data;
    }

    /** GET /logs/:id?err=true */
    async logs(getter: Getter, opts?: { err?: boolean }): Promise<{ out: string, err: string }> {
        const res = await this.http.get(`/logs/${getter}`, {
            params: opts
        });
        return res.data as { out: string, err: string };
    }
}
