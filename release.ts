import { $ } from "bun";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RELEASE_PUBLIC_KEY, verifySums } from "./projects/release";

// The Ed25519 private key that signs releases. Lives only on the release
// machine, never in the repo. pdd refuses to self-update to unsigned releases.
const keyPath = process.env.PDD_SIGNING_KEY ?? path.join(os.homedir(), ".config", "pdd-release", "signing-key.pem");

const mdPath = process.argv[2] ?? "Release.md";
const defaultAssetPaths = [
    "./pdd-linux-x64.gz",
    "./pdd-linux-arm64.gz",
    "./pd-linux-x64.gz",
    "./pd-linux-arm64.gz",
];
const assetPaths = process.argv.length > 3 ? process.argv.slice(3) : defaultAssetPaths;

const raw = await Bun.file(mdPath).text();

let title = "";
let version = "";
const notesLines: string[] = [];

for (const line of raw.split("\n")) {
    const titleMatch = line.match(/^title:\s*(.*)$/i);
    const versionMatch = line.match(/^version:\s*(.*)$/i);

    if (titleMatch?.[1]) {
        title = titleMatch[1].trim();
    } else if (versionMatch?.[1]) {
        version = versionMatch[1].trim();
    } else {
        notesLines.push(line);
    }
}

const notes = notesLines.join("\n").trim();

if (!title) throw new Error(`No "title:" line found in ${mdPath}`);
if (!version) throw new Error(`No "version:" line found in ${mdPath}`);

// `pd update` compares against the version baked into the binary from package.json,
// so a tag that doesn't match it would make every install nag (or never nag) forever.
const pkgVersion = (await Bun.file("package.json").json()).version as string;
if (version.replace(/^\D+/, "") !== pkgVersion) {
    throw new Error(`Release tag "${version}" doesn't match package.json version "${pkgVersion}"`);
}

// The default assets are gitignored build output, so rebuild them right before
// uploading instead of trusting whatever stale .gz files happen to be on disk.
if (assetPaths === defaultAssetPaths) {
    console.log("Building binaries...");
    await $`bun run build:server`;
}

// Sign: SHA256SUMS lists every asset's hash, SHA256SUMS.sig signs that file.
const keyFile = Bun.file(keyPath);
if (!(await keyFile.exists())) throw new Error(`Signing key not found at ${keyPath} (set PDD_SIGNING_KEY)`);
const privateKey = createPrivateKey(await keyFile.text());
const derivedPub = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();
if (derivedPub !== RELEASE_PUBLIC_KEY.trim()) {
    throw new Error("Signing key doesn't match RELEASE_PUBLIC_KEY in projects/release.ts; installed daemons would reject this release");
}
let sums = "";
for (const p of assetPaths) {
    const hash = createHash("sha256").update(new Uint8Array(await Bun.file(p).arrayBuffer())).digest("hex");
    sums += `${hash}  ${path.basename(p)}\n`;
}
await Bun.write("./SHA256SUMS", sums);
const signature = sign(null, Buffer.from(sums), privateKey).toString("base64");
await Bun.write("./SHA256SUMS.sig", signature + "\n");
if (!verifySums(new TextEncoder().encode(sums), signature)) throw new Error("Self-check of the new signature failed");
console.log("Signed SHA256SUMS");
assetPaths.push("./SHA256SUMS", "./SHA256SUMS.sig");

console.log(`Creating release ${version} ("${title}") from ${assetPaths.join(", ")}...`);

await $`gh release create ${version} ${assetPaths} --title ${title} --notes ${notes}`;
