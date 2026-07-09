import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import pkg from "../../package.json";

const GITHUB_REPO = "AirplaneGobrr-Trash/process-daemon";
const CACHE_PATH = path.join(os.homedir(), ".cache", "pd", "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const CURRENT_VERSION: string = pkg.version;

interface UpdateCache {
    checkedAt: number;
    latestVersion: string;
    releaseUrl: string;
}

export interface ReleaseInfo {
    version: string;
    tag: string;
    name: string;
    body: string;
    url: string;
}

function parseVersion(tag: string): string {
    return tag.replace(/^\D*/, "");
}

// Compares two dotted version strings. >0 if a is newer, <0 if b is newer, 0 if equal.
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(n => parseInt(n, 10) || 0);
    const pb = b.split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export async function fetchLatestRelease(timeoutMs = 5000): Promise<ReleaseInfo> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers: { "User-Agent": "pd-cli", "Accept": "application/vnd.github+json" },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const data = await res.json() as { tag_name: string; name: string; body: string; html_url: string };
        return {
            version: parseVersion(data.tag_name),
            tag: data.tag_name,
            name: data.name || data.tag_name,
            body: data.body || "",
            url: data.html_url,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function readCache(): Promise<UpdateCache | null> {
    try {
        return await Bun.file(CACHE_PATH).json();
    } catch {
        return null;
    }
}

async function writeCache(cache: UpdateCache): Promise<void> {
    await Bun.write(CACHE_PATH, JSON.stringify(cache), { createPath: true }).catch(() => {});
}

// Refreshes the cache in the background if it's missing or stale. Best-effort:
// swallows all errors so a flaky network never affects the calling command.
export async function refreshUpdateCacheIfStale(): Promise<void> {
    const cache = await readCache();
    if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;
    try {
        const release = await fetchLatestRelease(2000);
        await writeCache({ checkedAt: Date.now(), latestVersion: release.version, releaseUrl: release.url });
    } catch {
        // Leave the existing (possibly absent) cache in place; try again next stale check.
    }
}

// Prints a nag banner from whatever is cached. Never touches the network, so it's instant.
export async function printUpdateNagIfAvailable(): Promise<void> {
    const cache = await readCache();
    if (!cache) return;
    if (compareVersions(cache.latestVersion, CURRENT_VERSION) <= 0) return;

    const isTTY = process.stdout.isTTY;
    const yellow = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
    const bold = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;

    console.log("");
    console.log(yellow(`⚠ New pd version available: ${CURRENT_VERSION} → ${cache.latestVersion}`));
    console.log(yellow(`  Run ${bold("pd update")} or see ${cache.releaseUrl}`));
}

function resolveArch(): "x64" | "arm64" {
    if (process.arch === "x64" || process.arch === "arm64") return process.arch;
    throw new Error(`unsupported architecture: ${process.arch}`);
}

async function downloadAsset(name: string, destPath: string): Promise<void> {
    const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/${name}.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to download ${name}: ${res.status}`);
    const gz = new Uint8Array(await res.arrayBuffer());
    await Bun.write(destPath, Bun.gunzipSync(gz));
}

// Downloads the latest pd/pdd binaries, installs them over the current ones via sudo,
// and restarts the pdd service so the daemon picks up the new binary too.
export async function installUpdate(release: ReleaseInfo): Promise<void> {
    if (process.platform !== "linux") throw new Error("pd update only supports Linux");
    const arch = resolveArch();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pd-update-"));
    try {
        const pdTmp = path.join(tmpDir, "pd");
        const pddTmp = path.join(tmpDir, "pdd");

        await downloadAsset(`pd-linux-${arch}`, pdTmp);
        await downloadAsset(`pdd-linux-${arch}`, pddTmp);

        const installPd = spawnSync("sudo", ["install", "-m", "755", pdTmp, "/usr/local/bin/pd"], { stdio: "inherit" });
        if (installPd.status !== 0) throw new Error("failed to install pd binary");

        const installPdd = spawnSync("sudo", ["install", "-m", "755", pddTmp, "/usr/local/bin/pdd"], { stdio: "inherit" });
        if (installPdd.status !== 0) throw new Error("failed to install pdd binary");
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    process.stderr.write("Restarting pdd...\n");
    const restart = spawnSync("sudo", ["systemctl", "restart", "pdd"], { stdio: "inherit" });
    if (restart.status !== 0) {
        process.stderr.write("warning: pdd binary updated but the service failed to restart\n  → try: sudo systemctl restart pdd\n");
    }

    await writeCache({ checkedAt: Date.now(), latestVersion: release.version, releaseUrl: release.url });
}
