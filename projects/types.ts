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
    // Defaults to "." TODO: Don't do that unless using bun/node
    script?: string;
    // Defaults to bun
    interpreter?: string;
    restart?: boolean;
    maxRestarts?: number;
    env?: Record<string, string>;
    // When set, `cwd` is a checkout of this repo: POST /deploy clones it (if cwd
    // is missing/empty) or fetches + hard-resets it, runs `build`, then restarts.
    git?: GitOptions;
    // Shell commands run in cwd, in order, after every clone/fetch (e.g. "bun install").
    build?: string[];
}

export interface GitOptions {
    repo: string;
    // Defaults to "main"
    branch?: string;
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
    // Captured at spawn time, independent of `monit` (which only updates once
    // pidusage successfully polls). Always reflects the real pid of the live child.
    pid?: number;
    monit?: Stat;
    lastAction?: Actions;
    lastError?: string;
    status?: Status;
    logFiles?: string[];
    // SHA currently checked out in cwd, set by the last successful deploy.
    commit?: string;
    lastDeploy?: DeployInfo;
}

export interface DeployInfo {
    at: string;          // ISO timestamp
    ok: boolean;
    commit?: string;
    error?: string;
}

export interface DeployResult {
    id: number;
    ok: boolean;
    // false when the remote branch was already at the checked-out commit
    changed: boolean;
    commit?: string;
    previousCommit?: string;
    // a failed build was reverted to previousCommit (and rebuilt)
    rolledBack?: boolean;
    // set when the process had no git config and it was read from the existing
    // checkout's origin + current branch; saved to the process on success
    inferredGit?: GitOptions;
    error?: string;
    // combined git + build output (tail, capped)
    output: string;
}

export interface DeployActionResult extends ActionResult {
    deploys: DeployResult[];
}

export type BindHost = "127.0.0.1" | "0.0.0.0";

export interface DaemonConfig {
    authEnabled: boolean;
    host: BindHost;
    // Answer `pd discover` UDP broadcasts. Only effective while host is 0.0.0.0.
    discoverable: boolean;
}

// One reply to a discovery broadcast. Never includes the token.
export interface DiscoveredDaemon {
    address: string;   // IP the reply came from
    port: number;
    hostname: string;
    version: string;
    authEnabled: boolean;
}

export interface DaemonConfigWithToken extends DaemonConfig {
    token: string;
}

export interface ActionResult {
    // ids of processes the action actually applied to
    affected: number[];
    // full process list, refreshed (monit included) after the action ran
    processes: ProcessInfo[];
    // only present when the action ran a deploy (POST /start with `git`)
    deploys?: DeployResult[];
}

export interface LogStreamMessage {
    id: number;
    type: "out" | "err";
    line: string;
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