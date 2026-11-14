title: Version 1.4.0
version: dev-1.4.0
**Breaking: the API now requires a token and listens on 127.0.0.1 by default.** Local use (`pd`, the SDK on the same machine) keeps working with no changes, since the token is read automatically from `/var/lib/pdd/config.json`. Anything calling pdd from another machine needs `pd server public` on the daemon and the token from `pd auth token`.
- Git deploys: `pd start --name api --cwd /srv/api --git <repo> --branch main --build "bun install"` clones, builds and starts in one step. `pd deploy <name|all>` fetches the branch, hard-resets to it, runs the build commands, and restarts the process if the commit changed (`-f` to force, `-v` for full output). A failed build rolls back to the previous commit and leaves the running app alone. `pd ls` shows a COMMIT column for git-backed processes.
- `pd deploy <name>` on a process whose folder is already a git checkout picks up its origin URL and branch automatically (it refuses if there are uncommitted changes, unless `-f`).
- Ecosystem files accept `repo`, `branch` and `build` (or PM2's `post_update`) per app.
- API auth: `pd auth token | status | enable | disable | rotate`.
- Listen address: `pd server local` (127.0.0.1) or `pd server public` (0.0.0.0), switched live without restarting the daemon.
- LAN discovery: `pd discover` lists pdd daemons on the local network. Daemons answer only while public, and `pd server broadcast off` hides them.
- `pd config`: interactive menu for auth, listen address, discovery and the token.
- Edit a process's settings in place (name, cwd, script, interpreter, restart, env, git) from the dashboard's Edit form or `POST /config/:getter`, without removing and re-adding it.
- The dashboard asks for the API token once and remembers it in the browser.
- Fix every process coming back stopped after the daemon restarts (`systemctl restart pdd`, `pd update`). Processes that were running before now start again.
- Fix the `url.parse() DeprecationWarning` printed on every `pd` command. The SDK now uses native `fetch` and no longer depends on axios.
- SDK: `new ProcClient(url, { token })`, `deploy()`, `discover()`, and the daemon settings calls. The default URL is now `http://127.0.0.1:3830`.
