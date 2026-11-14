import fs from "node:fs/promises";
import { constants as fsc, realpathSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json";
import {
    BIN_DIR, LAST_UPDATE_FILE, PENDING_FILE, ROLLBACK_FILE,
    compareVersions, downloadVerified, fetchLatestRelease, installBinaries, type ReleaseInfo,
} from "../release";
import { getConfig } from "./config";
import type { LastUpdate, UpdateStatus } from "../types";

export const VERSION: string = pkg.version;

// A new binary counts as good once it has stayed up this long.
const HEALTHY_AFTER_MS = 60_000;
const AUTO_FIRST_CHECK_MS = 10 * 60_000;
const AUTO_INTERVAL_MS = 6 * 60 * 60_000;

let restartHook: (() => Promise<void>) | undefined;
let updating = false;
let latest: { version: string; checkedAt: string } | undefined;

// Can this daemon replace its own binary? Only when it runs from BIN_DIR (the
// layout install.sh sets up) and BIN_DIR is writable by us.
export async function canSelfUpdate(): Promise<{ ok: boolean; reason?: string }> {
    let exe: string;
    try {
        exe = realpathSync(process.execPath);
    } catch {
        return { ok: false, reason: "can't resolve the pdd executable path" };
    }
    if (path.basename(exe) !== "pdd") return { ok: false, reason: "not running as an installed pdd binary (dev mode)" };
    let binDir: string | undefined;
    try { binDir = realpathSync(BIN_DIR); } catch {}
    if (path.dirname(exe) !== binDir) {
        return { ok: false, reason: `pdd runs from ${exe}, not ${BIN_DIR}; re-run the installer once (it needs sudo) to enable self-update` };
    }
    try {
        await fs.access(BIN_DIR, fsc.W_OK);
    } catch {
        return { ok: false, reason: `${BIN_DIR} isn't writable by this user` };
    }
    return { ok: true };
}

async function readLast(): Promise<LastUpdate | undefined> {
    try {
        return JSON.parse(await fs.readFile(LAST_UPDATE_FILE, "utf8"));
    } catch {
        return undefined;
    }
}

async function writeLast(last: LastUpdate) {
    await fs.writeFile(LAST_UPDATE_FILE, JSON.stringify(last, null, 2) + "\n").catch(() => {});
}

export async function status(check = false): Promise<UpdateStatus> {
    if (check) {
        try {
            const r = await fetchLatestRelease();
            latest = { version: r.version, checkedAt: new Date().toISOString() };
        } catch (err) {
            latest = undefined;
            const self = await canSelfUpdate();
            return {
                version: VERSION, autoUpdate: getConfig().autoUpdate, updating, canSelfUpdate: self.ok, reason: self.reason,
                checkError: err instanceof Error ? err.message : String(err), last: await readLast(),
            };
        }
    }
    const self = await canSelfUpdate();
    return {
        version: VERSION,
        latest: latest?.version,
        checkedAt: latest?.checkedAt,
        updateAvailable: latest ? compareVersions(latest.version, VERSION) > 0 : undefined,
        autoUpdate: getConfig().autoUpdate,
        updating,
        canSelfUpdate: self.ok,
        reason: self.reason,
        last: await readLast(),
    };
}

// Installs the latest signed release and restarts into it. Resolves once the
// new binaries are in place (the restart happens just after), so an HTTP
// caller gets an answer before the daemon goes away.
export async function update(opts: { force?: boolean; auto?: boolean } = {}): Promise<{ started: boolean; from: string; to?: string; reason?: string }> {
    if (updating) return { started: false, from: VERSION, reason: "an update is already in progress" };
    const self = await canSelfUpdate();
    if (!self.ok) return { started: false, from: VERSION, reason: self.reason };

    updating = true;
    let release: ReleaseInfo;
    try {
        release = await fetchLatestRelease();
        latest = { version: release.version, checkedAt: new Date().toISOString() };
        if (compareVersions(release.version, VERSION) <= 0 && !opts.force) {
            updating = false;
            return { started: false, from: VERSION, to: release.version, reason: "already up to date" };
        }
        // Auto-update never retries a version that already failed to start here;
        // installing it again takes an explicit update.
        const last = await readLast();
        if (opts.auto && last?.rolledBack && last.to === release.version) {
            updating = false;
            return { started: false, from: VERSION, to: release.version, reason: `v${release.version} was rolled back on this node; update manually to retry` };
        }
        const bins = await downloadVerified(release);
        await installBinaries(bins, VERSION, release.version);
    } catch (err) {
        updating = false;
        const message = err instanceof Error ? err.message : String(err);
        await writeLast({ at: new Date().toISOString(), ok: false, from: VERSION, error: message });
        throw err;
    }

    console.log(`[pdd] installed v${release.version}, restarting into it`);
    setTimeout(() => void restartHook?.(), 300);
    return { started: true, from: VERSION, to: release.version };
}

// Called once at boot. Settles a pending update (healthy or rolled back) and
// starts the auto-update timer.
export async function initSelfUpdate(restart: () => Promise<void>): Promise<void> {
    restartHook = restart;

    // The launcher rolled back a version that wouldn't start.
    try {
        const msg = (await fs.readFile(ROLLBACK_FILE, "utf8")).trim();
        console.error(`[pdd] ${msg}`);
        // "update A -> B failed to start ..."
        const m = msg.match(/update (\S+) -> (\S+)/);
        await writeLast({ at: new Date().toISOString(), ok: false, error: msg, rolledBack: true, from: m?.[1], to: m?.[2] });
        await fs.rm(ROLLBACK_FILE, { force: true });
    } catch {}

    // We are the new version: confirm it after a quiet minute.
    try {
        const pending = (await fs.readFile(PENDING_FILE, "utf8")).trim();
        setTimeout(async () => {
            await fs.rm(PENDING_FILE, { force: true });
            await fs.rm(`${PENDING_FILE}.tries`, { force: true });
            const [from] = pending.split(" -> ");
            await writeLast({ at: new Date().toISOString(), ok: true, from, to: VERSION });
            console.log(`[pdd] update ${pending} confirmed healthy`);
        }, HEALTHY_AFTER_MS).unref?.();
    } catch {}

    const tick = async () => {
        if (!getConfig().autoUpdate || updating) return;
        try {
            const r = await update({ auto: true });
            if (r.started) console.log(`[pdd] auto-update: ${r.from} -> ${r.to}`);
        } catch (err) {
            console.error("[pdd] auto-update failed:", err instanceof Error ? err.message : err);
        }
    };
    setTimeout(() => {
        void tick();
        setInterval(() => void tick(), AUTO_INTERVAL_MS).unref?.();
    }, AUTO_FIRST_CHECK_MS).unref?.();
}
