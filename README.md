# process-daemon (pdd)

A simple, bun-powered process manager. Just run your scripts and keep them alive.

---

> **Security warning**
> This project has not been audited for injection vulnerabilities. The daemon accepts process options over HTTP with **no authentication and no input sanitisation**: fields like `cwd`, `script`, `interpreter`, and `env` are passed directly to the host's process spawn. **Never expose port 3830 to an untrusted network or allow untrusted users to submit input to the daemon.** Doing so is remote code execution.

---

## Install

Ubuntu 24/25 (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/AirplaneGobrr-Trash/process-daemon/main/install.sh | bash
```

This downloads the pre-built binary to `/usr/local/bin/pdd`, creates `/var/lib/pdd/` for state and logs, and registers a systemd service that starts on boot.

### Managing the service

```bash
sudo systemctl status pdd
sudo systemctl stop pdd
sudo systemctl restart pdd
sudo systemctl disable pdd  # stop it starting on boot
```

### Uninstall

```bash
sudo systemctl stop pdd && sudo systemctl disable pdd
sudo rm /usr/local/bin/pdd /etc/systemd/system/pdd.service
sudo rm -rf /var/lib/pdd
```

---

## Client SDK

Use the SDK to control pdd from any Bun or Node project.

See [projects/client/README.md](projects/client/README.md) for the full SDK docs and examples.

```bash
bun add @airplanegobrr/process-daemon
```

```ts
import { ProcClient } from "@airplanegobrr/process-daemon";

const pd = new ProcClient(); // connects to http://localhost:3830
await pd.start({ name: "api", cwd: "/home/user/api", script: "index.ts", restart: true });
```

---

## CLI quick reference

| Command | Description |
|---------|-------------|
| `pd list` / `pd ls` | Table of all processes with status, CPU, mem, uptime |
| `pd start` | Interactive setup, or auto-detects an ecosystem file in cwd |
| `pd start <name\|id>` | Start a stopped existing process |
| `pd start --name foo --cwd /path [flags]` | Define and start a new process |
| `pd start --efile [path]` | Start all processes from an ecosystem file |
| `pd stop <getter>` | Stop (accepts name, id, or `all`) |
| `pd restart <getter>` | Restart |
| `pd remove <getter>` / `pd rm` | Remove |
| `pd env <getter> KEY=VALUE...` | Update env vars (merges by default; `--replace` to overwrite); restarts the process if it's running |
| `pd logs <getter> [--out\|--err] [--runs N] [-f]` | Show stdout and/or stderr (last 3 runs by default); `-f` streams new lines live until Ctrl+C |

`pd start` flags: `--script`, `--interpreter`, `--restart`, `--max-restarts <n>`, `--env KEY=VALUE`, `--efile [path]`.

### Ecosystem files

`pd start` looks for an ecosystem file in the current directory automatically (`ecosystem.config.js`, `ecosystem.config.cjs`, `ecosystem.config.json`, or `ecosystem.json`). You can also point at one explicitly:

```bash
pd start --efile ./apps.json
```

The format is PM2-compatible. (not 100% tested) Existing `ecosystem.config.js` files work without modification:

```json
{
  "apps": [
    {
      "name": "api",
      "cwd": "/srv/api",
      "script": "index.ts",
      "autorestart": true,
      "max_restarts": 5,
      "env": { "NODE_ENV": "production" }
    },
    {
      "name": "worker",
      "cwd": "/srv/worker",
      "autorestart": true
    }
  ]
}
```

After using the interactive `pd start` prompt, you'll be offered the option to save the process to an ecosystem file for later reuse.

### Interactive prompt

Running `pd start` with no arguments launches an interactive setup wizard. The **working directory**, **entrypoint**, and **ecosystem file path** fields support Tab completion. Press Tab to expand directories and filenames.

---

## State

Process state is saved to `/var/lib/pdd/processes.json` after every action and restored on daemon restart. Logs are stored in `/var/lib/pdd/logs/`.

---

## Troubleshooting

### Process shows `error` status with no logs

This is a server-side pre-flight failure. Check the `ERROR` column in `pd list` for the reason. Common causes:

- **`No interpreter`**: the daemon couldn't find the interpreter (e.g. `bun`) in its PATH. The `pd` CLI automatically writes bun's location to `/var/lib/pdd/env` when it starts the daemon, but if you started the service manually via `systemctl`, that file may be missing. Fix: run any `pd` command to let it write the env file, then `sudo systemctl restart pdd`.
- **`No CWD Exists`**: the working directory configured for the process doesn't exist.
- **`No Script Exists`**: the script path doesn't exist within the configured CWD.

### Daemon service logs

```bash
journalctl -u pdd -f
```
