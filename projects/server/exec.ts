import os from "node:os";
import type { ExecResult } from "../types";

const MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

// Runs one shell command and collects its output. Same trust level as POST
// /start (which already runs any interpreter): this just skips the "make it a
// managed process" part, for one-off commands like `df -h` or `git status`.
export async function runCommand(command: string, cwd: string | undefined, env: Record<string, string> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
    const dir = cwd || os.homedir();
    const limit = Math.min(Math.max(1000, timeoutMs), MAX_TIMEOUT_MS);
    const started = Date.now();
    const child = Bun.spawn({
        cmd: ["sh", "-c", command],
        cwd: dir,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Own process group, so the timeout kill takes out anything it forked.
        detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, limit);

    let truncated = false;
    const collect = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        let text = "";
        for await (const chunk of stream) {
            text += decoder.decode(chunk, { stream: true });
            if (text.length > MAX_OUTPUT) { text = text.slice(-MAX_OUTPUT); truncated = true; }
        }
        return text;
    };
    const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
    const code = await child.exited;
    clearTimeout(timer);
    return { code: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started, cwd: dir, truncated };
}
