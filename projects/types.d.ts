import type { ChildProcess } from "child_process";

export interface ProcessOptions {
    name: string;
    script?: string;
    cwd: string;
    interpreter?: string;
    restart?: boolean;
}

export interface CustomSpawn extends ChildProcess {
    __noRestart?: boolean;
}

export interface ManagedProcess {
    id: string;
    name: string;
    config: ProcessOptions;
    child?: CustomSpawn;
    lastExit?: number;
    lastCode?: number | null;
    started: number;
    status: "stopped" | "error" | "online";
    restart: boolean;
}

export class ProcClient {}