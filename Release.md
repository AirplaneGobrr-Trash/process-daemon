title: Version 1.3.0
version: dev-1.3.0
- New web dashboard at `http://<host>:3830/`: live process table (status, PID, CPU, memory, uptime, errors), start/stop/restart buttons, and click-a-row live logs. Built into `pdd`, no extra setup or dependencies.
- Fix processes getting stuck: after `pd stop` (or the stop half of `pd restart`), `pd start` could silently do nothing, so the process only came back after `pd rm` and adding it again. Signal-killed children are now correctly detected as exited.
- Fix double-spawns when a manual start/restart overlapped a pending auto-restart, which could leave an untracked copy running and holding the port.
- `pd stop` no longer hangs on a child that ignores SIGTERM: it escalates to SIGKILL on the whole process group after 5s. Orphan cleanup on daemon startup does the same.
- The daemon now persists each process's real pid on every spawn (including auto-restarts) and refuses to double-spawn on startup if an old pid can't be reclaimed.
- `processes.json` is written atomically, so a crash mid-save can no longer corrupt it.
- `pdd` refuses to start if another instance is already running.
- Ecosystem files now use paths relative to the file itself: a relative or missing `cwd` resolves against the ecosystem file's directory, and saving writes `cwd` relative to it. `--cwd` and the interactive prompt are resolved to absolute paths too, so relative paths no longer break.
- `pd logs` groups output per run with a header showing when it started and how it ended, defaults to the last run, and accepts the count as a positional arg (`pd logs api 3`).
