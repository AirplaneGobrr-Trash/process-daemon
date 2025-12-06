import axios, { type AxiosInstance } from "axios";
import type { ManagedProcess, ProcessOptions } from "../types";

export class ProcClient {
    private http: AxiosInstance;

    constructor(baseURL = "http://localhost:3830") {
        this.http = axios.create({
            baseURL,
            timeout: 5000
        });
    }

    /** GET /list */
    async list(): Promise<ManagedProcess[]> {
        const res = await this.http.get("/list");
        return res.data;
    }

    /** POST /start */
    async start(config: ProcessOptions): Promise<ManagedProcess> {
        const res = await this.http.post("/start", config);
        return res.data;
    }

    /** GET /delete/:id */
    async delete(id: string): Promise<string> {
        const res = await this.http.get(`/delete/${id}`);
        return res.data;
    }

    /** GET /logs/:id?err=true */
    async logs(id: string, opts?: { err?: boolean }): Promise<string> {
        const res = await this.http.get(`/logs/${id}`, {
            params: opts,
            responseType: "text"
        });
        return res.data;
    }
}
