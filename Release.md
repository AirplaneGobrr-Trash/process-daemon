title: Version 1.2.0
version: dev-1.2.0
- Add `pd env <getter> KEY=VALUE...` and `POST /env/:getter`: update a process's environment variables in place (merge by default, `--replace`/`{ replace: true }` to overwrite). A running process restarts immediately to pick up the change; a stopped process just has its stored options updated for next start. Env changes persist to `processes.json`.
- Compress release binaries with gzip before upload, cutting GitHub release asset size by roughly 62%. `install.sh` and `pd update` both transparently decompress on download.
- Add a `release.ts` script (and `bun run release`) for publishing GitHub releases from a `Release.md` file.
