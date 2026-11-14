title: Version 1.5.0
version: dev-1.5.0
**pdd now updates itself, and this is the last update that needs sudo.** Install it with the one-liner below (or `pd update`, which asks for sudo once). It moves the binaries into `/var/lib/pdd/bin` and restarts pdd. Processes, logs and settings are kept.

```
curl -fsSL https://raw.githubusercontent.com/AirplaneGobrr-Trash/process-daemon/main/install.sh | bash
```

- Self-update: `pd update` (no sudo after this release), `POST /daemon/update`, or automatically every 6 hours (on by default, `pd autoupdate off` to turn it off). Updating restarts pdd, so managed processes restart briefly.
- Releases are signed (Ed25519). pdd checks the signature and every binary's checksum before installing, and refuses unsigned or tampered releases.
- Automatic rollback: if a new version fails to start 3 times, the previous one is put back and the failure is reported in `pd autoupdate` and `GET /daemon/update`. Auto-update won't retry that version.
- Run commands: `POST /exec` runs a shell command in a process's folder (with its env) or any folder, and returns the output.
- Files: `GET /files/:getter`, `GET /file/:getter` and `PUT /file/:getter` list, read and write text files inside a process's folder (no escaping it, symlinks included).
- `GET /daemon` now includes the pdd version.
- SDK: `exec()`, `listFiles()`, `readFile()`, `writeFile()`, `getUpdateStatus()`, `updateDaemon()`, `setAutoUpdate()`.
