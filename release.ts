import { $ } from "bun";

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

console.log(`Creating release ${version} ("${title}") from ${assetPaths.join(", ")}...`);

await $`gh release create ${version} ${assetPaths} --title ${title} --notes ${notes}`;
