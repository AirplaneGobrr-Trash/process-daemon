// Release download + verification + install, shared by the daemon's self-update
// and `pd update`. Every release ships SHA256SUMS (sha256 of each .gz asset) and
// SHA256SUMS.sig (an Ed25519 signature over that file, made with a key that
// never leaves the release machine). A binary is only installed if the
// signature checks out against RELEASE_PUBLIC_KEY and its hash is listed.

import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GITHUB_REPO = "AirplaneGobrr-Trash/process-daemon";

// Overridable for testing against a local mirror. Releases are verified against
// RELEASE_PUBLIC_KEY either way, so pointing these elsewhere can't get an
// unsigned binary installed.
const RELEASE_API = process.env.PDD_RELEASE_API ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const DOWNLOAD_BASE = process.env.PDD_RELEASE_DOWNLOAD ?? `https://github.com/${GITHUB_REPO}/releases/download`;

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJKSzwhhQrw5mTlklbwotusWIw3pTjtoT/ewZGhoXVEQ=
-----END PUBLIC KEY-----`;

// The installed layout (see install.sh). Binaries live in a directory the pdd
// user owns, so updates never need root; /usr/local/bin/{pd,pdd} are symlinks.
export const DATA_DIR = process.env.PDD_DATA_DIR ?? "/var/lib/pdd";
export const BIN_DIR = path.join(DATA_DIR, "bin");
export const PENDING_FILE = path.join(DATA_DIR, "update-pending");
export const ROLLBACK_FILE = path.join(DATA_DIR, "update-rollback");
export const LAST_UPDATE_FILE = path.join(DATA_DIR, "last-update.json");

export interface ReleaseInfo {
    version: string;
    tag: string;
    name: string;
    body: string;
    url: string;
}

export function parseVersion(tag: string): string {
    return tag.replace(/^\D*/, "");
}

// >0 if a is newer, <0 if b is newer, 0 if equal.
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
    const res = await fetch(RELEASE_API, {
        headers: { "User-Agent": "pdd", "Accept": "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
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
}

export function resolveArch(): "x64" | "arm64" {
    if (process.arch === "x64" || process.arch === "arm64") return process.arch;
    throw new Error(`unsupported architecture: ${process.arch}`);
}

async function download(tag: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
    // By tag, not /latest/, so a release published mid-update can't mix versions.
    const url = `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${name}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
    if (!res.ok) throw new Error(`download of ${name} failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

export function verifySums(sums: Uint8Array, signatureB64: string, publicKeyPem = RELEASE_PUBLIC_KEY): boolean {
    try {
        return verify(null, sums, createPublicKey(publicKeyPem), Buffer.from(signatureB64.trim(), "base64"));
    } catch {
        return false;
    }
}

export function sha256(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

// Parses `sha256sum` output: "<hex>  <name>" per line.
export function parseSums(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
        const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
        if (m) map.set(m[2]!, m[1]!);
    }
    return map;
}

// Downloads pd + pdd for this machine's arch and returns the verified,
// decompressed binaries. Throws on a missing/invalid signature or hash mismatch.
export async function downloadVerified(release: ReleaseInfo): Promise<{ pdd: Uint8Array; pd: Uint8Array }> {
    const arch = resolveArch();
    const [sums, sig] = await Promise.all([download(release.tag, "SHA256SUMS"), download(release.tag, "SHA256SUMS.sig")])
        .catch(err => { throw new Error(`release ${release.tag} is not signed (${err.message}); refusing to install it`); });
    if (!verifySums(sums, new TextDecoder().decode(sig))) {
        throw new Error(`release ${release.tag} has an INVALID signature; refusing to install it`);
    }
    const hashes = parseSums(new TextDecoder().decode(sums));
    const out: Record<string, Uint8Array> = {};
    for (const bin of ["pdd", "pd"] as const) {
        const asset = `${bin}-linux-${arch}.gz`;
        const expected = hashes.get(asset);
        if (!expected) throw new Error(`${asset} is not listed in the signed SHA256SUMS`);
        const gz = await download(release.tag, asset);
        if (sha256(gz) !== expected) throw new Error(`${asset} does not match its signed checksum`);
        out[bin] = Bun.gunzipSync(gz);
    }
    return { pdd: out.pdd!, pd: out.pd! };
}

// systemd runs this instead of pdd directly. If a freshly installed pdd keeps
// failing to start (it never got to clear the pending marker), the previous
// binaries are put back on the 4th start attempt. Plain sh, so it still works
// when the new pdd can't even execute.
export const LAUNCHER = `#!/bin/sh
# Installed by pdd. Starts pdd and rolls back a self-update that won't start.
BIN="$(dirname "$(readlink -f "$0")")"
DATA="$(dirname "$BIN")"
PENDING="$DATA/update-pending"
if [ -f "$PENDING" ]; then
    n=$(cat "$PENDING.tries" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$PENDING.tries"
    if [ "$n" -gt 3 ] && [ -f "$BIN/pdd.prev" ]; then
        mv -f "$BIN/pdd.prev" "$BIN/pdd"
        [ -f "$BIN/pd.prev" ] && mv -f "$BIN/pd.prev" "$BIN/pd"
        echo "update $(cat "$PENDING") failed to start $((n - 1)) times; rolled back" > "$DATA/update-rollback"
        rm -f "$PENDING" "$PENDING.tries"
    fi
fi
exec "$BIN/pdd" "$@"
`;

async function writeAtomic(file: string, data: Uint8Array | string, mode: number) {
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, data, { mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
}

// Puts verified binaries into BIN_DIR, keeping the current ones as *.prev for
// the launcher's rollback, and marks the update pending until the new daemon
// has run healthy for a while. Needs only write access to BIN_DIR.
export async function installBinaries(bins: { pdd: Uint8Array; pd: Uint8Array }, from: string, to: string): Promise<void> {
    await fs.mkdir(BIN_DIR, { recursive: true });
    for (const name of ["pdd", "pd"] as const) {
        const target = path.join(BIN_DIR, name);
        await fs.copyFile(target, `${target}.prev`).catch(() => {});
        await writeAtomic(target, bins[name], 0o755);
    }
    await writeAtomic(path.join(BIN_DIR, "pdd-launch"), LAUNCHER, 0o755);
    await fs.rm(`${PENDING_FILE}.tries`, { force: true });
    await fs.writeFile(PENDING_FILE, `${from} -> ${to}`);
}

// The systemd unit for the self-updating layout. Restart=always so a clean
// self-update exit also restarts; no start limit so the launcher's rollback
// gets its chance after a few failed starts.
export function serviceUnit(user: string): string {
    return `[Unit]
Description=Process Daemon (pdd)
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${user}
ExecStart=${BIN_DIR}/pdd-launch
WorkingDirectory=${DATA_DIR}
EnvironmentFile=-${DATA_DIR}/env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
