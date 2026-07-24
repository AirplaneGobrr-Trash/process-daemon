import { $ } from "bun";

const mdPath = process.argv[2] ?? "Release.md";
const assetPath = process.argv[3] ?? "./dist/app.zip";

const raw = await Bun.file(mdPath).text();

let title = "";
let version = "";
const notesLines: string[] = [];

for (const line of raw.split("\n")) {
    const titleMatch = line.match(/^title:\s*(.*)$/i);
    const versionMatch = line.match(/^version:\s*(.*)$/i);

    if (titleMatch) {
        title = titleMatch[1].trim();
    } else if (versionMatch) {
        version = versionMatch[1].trim();
    } else {
        notesLines.push(line);
    }
}

const notes = notesLines.join("\n").trim();

if (!title) throw new Error(`No "title:" line found in ${mdPath}`);
if (!version) throw new Error(`No "version:" line found in ${mdPath}`);

console.log(`Creating release ${version} ("${title}") from ${assetPath}...`);

await $`gh release create ${version} ${assetPath} --title ${title} --notes ${notes}`;
