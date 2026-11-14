import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import type { BindHost, DaemonConfig, DaemonConfigWithToken } from "../types";

// Relative to the daemon's cwd, like processes.json: /var/lib/pdd/config.json in
// production. Holds the API token, so it's written 0600.
const configPath = "./config.json";

// PDD_PORT is for running a second dev/test daemon next to the real one.
export const PORT = Number(process.env.PDD_PORT) || 3830;

export function generateToken(): string {
    return randomBytes(32).toString("hex");
}

function isBindHost(v: unknown): v is BindHost {
    return v === "127.0.0.1" || v === "0.0.0.0";
}

let config: DaemonConfigWithToken;

// Secure defaults for a missing file: auth on, loopback only. Anything that can
// reach the API can run arbitrary commands (POST /start takes any interpreter),
// so opening it up is always an explicit `pd server public`.
export function loadConfig(): DaemonConfigWithToken {
    let stored: Partial<DaemonConfigWithToken> = {};
    if (existsSync(configPath)) {
        try {
            stored = JSON.parse(readFileSync(configPath, "utf8"));
        } catch (err) {
            console.error("[pdd] config.json is corrupt or unreadable, falling back to defaults with a new token:", err);
        }
    }
    config = {
        authEnabled: typeof stored.authEnabled === "boolean" ? stored.authEnabled : true,
        host: isBindHost(stored.host) ? stored.host : "127.0.0.1",
        discoverable: typeof stored.discoverable === "boolean" ? stored.discoverable : true,
        token: typeof stored.token === "string" && stored.token.length >= 32 ? stored.token : generateToken(),
    };
    return config;
}

export function getConfig(): DaemonConfigWithToken {
    return config;
}

// Same tmp + rename approach as processes.json, so a kill mid-write can't
// leave a truncated file (which would silently rotate the token on next boot).
export async function saveConfig(): Promise<void> {
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmpPath, configPath);
    await fs.chmod(configPath, 0o600).catch(() => {});
}

export async function updateConfig(patch: Partial<DaemonConfigWithToken>): Promise<DaemonConfigWithToken> {
    config = { ...config, ...patch };
    await saveConfig();
    return config;
}

export function publicView(c: DaemonConfigWithToken = config): DaemonConfig {
    return { authEnabled: c.authEnabled, host: c.host, discoverable: c.discoverable };
}

// Constant-time so the token can't be guessed byte-by-byte from response timing.
export function tokenMatches(given: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(config.token);
    return a.length === b.length && timingSafeEqual(a, b);
}
