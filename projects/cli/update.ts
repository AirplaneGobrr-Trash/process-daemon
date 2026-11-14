import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import pkg from "../../package.json";
import {
    BIN_DIR, compareVersions, downloadVerified, fetchLatestRelease, installBinaries, serviceUnit,
    type ReleaseInfo,
} from "../release";

export { compareVersions, fetchLatestRelease, type ReleaseInfo };

const CACHE_PATH = path.join(os.homedir(), ".cache", "pd", "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const CURRENT_VERSION: string = pkg.version;

interface UpdateCache {
    checkedAt: number;
    latestVersion: string;
    releaseUrl: string;
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

function sudo(args: string[], what: string) {
    const r = spawnSync("sudo", args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${what} failed`);
}

// One-time move to the self-updating layout (needs sudo, once): verified
// binaries go into BIN_DIR (owned by this user), /usr/local/bin/{pd,pdd}
// become symlinks to them, and the unit starts pdd through the rollback
// launcher with Restart=always. After this, pdd updates itself without root.
export async function migrateAndInstall(release: ReleaseInfo): Promise<void> {
    if (process.platform !== "linux") throw new Error("pd update only supports Linux");
    const user = os.userInfo().username;
    const dataDir = path.dirname(BIN_DIR);
    // The data dir is normally already ours (install.sh chowns it).
    try {
        await fs.mkdir(BIN_DIR, { recursive: true });
        await fs.access(BIN_DIR, fs.constants.W_OK);
    } catch {
        sudo(["mkdir", "-p", BIN_DIR], `creating ${BIN_DIR}`);
        sudo(["chown", "-R", `${user}:${user}`, dataDir], `chowning ${dataDir}`);
    }

    process.stderr.write("Downloading and verifying the signed release...\n");
    const bins = await downloadVerified(release);
    await installBinaries(bins, CURRENT_VERSION, release.version);

    process.stderr.write("Linking /usr/local/bin/pd and pdd, installing the service (sudo)...\n");
    sudo(["ln", "-sfn", path.join(BIN_DIR, "pdd"), "/usr/local/bin/pdd"], "linking pdd");
    sudo(["ln", "-sfn", path.join(BIN_DIR, "pd"), "/usr/local/bin/pd"], "linking pd");
    const tmp = path.join(os.tmpdir(), `pdd.service.${process.pid}`);
    await fs.writeFile(tmp, serviceUnit(user));
    sudo(["install", "-m", "644", tmp, "/etc/systemd/system/pdd.service"], "installing pdd.service");
    await fs.rm(tmp, { force: true });
    sudo(["systemctl", "daemon-reload"], "systemctl daemon-reload");
    sudo(["systemctl", "restart", "pdd"], "restarting pdd");

    await writeCache({ checkedAt: Date.now(), latestVersion: release.version, releaseUrl: release.url });
}

export async function noteInstalled(release: ReleaseInfo) {
    await writeCache({ checkedAt: Date.now(), latestVersion: release.version, releaseUrl: release.url });
}
