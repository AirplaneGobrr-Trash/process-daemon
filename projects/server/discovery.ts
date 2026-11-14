import dgram from "node:dgram";
import os from "os";
import { PORT, getConfig } from "./config";
import pkg from "../../package.json";
import type { DiscoveredDaemon } from "../types";

// Discovery is request/response, not a periodic beacon: `pd discover` (or the
// SDK's discover()) broadcasts one DISCOVER_MAGIC packet to UDP <port> and every
// pdd that's listening publicly answers with a small JSON description. Nothing
// is sent on the network unless someone is actively looking.
export const DISCOVER_MAGIC = "pdd-discover-v1";

export function startDiscoveryResponder(): void {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
        if (msg.toString() !== DISCOVER_MAGIC) return;
        const config = getConfig();
        // A loopback-only daemon isn't reachable from the asker anyway, so stay quiet.
        if (!config.discoverable || config.host !== "0.0.0.0") return;
        const reply: Omit<DiscoveredDaemon, "address"> = {
            port: PORT,
            hostname: os.hostname(),
            version: pkg.version,
            authEnabled: config.authEnabled,
        };
        socket.send(JSON.stringify(reply), rinfo.port, rinfo.address);
    });
    // Discovery is optional: a bind failure (port taken) must never take the daemon down.
    socket.on("error", err => console.error("[pdd] discovery socket error:", err));
    socket.bind(PORT, "0.0.0.0");
}
