import type { Process } from "./server/process";

export type Actions = "stop" | "start" | "restart" | "remove";
export type Getter = number | "all" | string;
export type ProcTypes = keyof typeof Process;


export enum Status {
    Stopped = "stopped",
    Stopping = "stopping",
    Online = "online",
    Starting = "starting",
    Error = "error",
}

export interface ProcessOptions {
    name: string;
    cwd: string;
    script?: string;
    interpreter?: string;
    restart?: boolean;
    maxRestarts?: number;
    env?: Record<string, string>;
}

export interface ProcessOptionsConfirmed extends ProcessOptions {
    script: string;
    interpreter: string;
}

export interface ProcessInfo {
    startOptions: ProcessOptions;
    process?: Process;
    id: number;
    name: string;
    monit?: Stat;
    lastAction?: Actions;
    lastError?: string;
    status?: Status
}

export interface Monit {
    cpu: string;
    memory: string;
    uptime: string;
}


export interface Stat {
    /**
     * percentage (from 0 to 100*vcore)
     */
    cpu: number;

    /**
     * bytes
     */
    memory: number;

    /**
     * PPID
     */
    ppid: number;

    /**
     * PID
     */
    pid: number;

    /**
     * ms user + system time
     */
    ctime: number;

    /**
     * ms since the start of the process
     */
    elapsed: number;

    /**
     * ms since epoch
     */
    timestamp: number;
}