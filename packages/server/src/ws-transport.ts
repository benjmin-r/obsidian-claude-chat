/**
 * Thin I/O shell: binds a `ws` WebSocketServer to the Tailscale IP and pumps
 * parsed frames through a per-socket `Connection`. The protocol logic lives in
 * `connection.ts`; this module only does socket plumbing + JSON framing.
 */

import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeEvent, ClientMessage } from "@occ/protocol";
import { Connection, createWriterRegistry, type WriterRegistry } from "./connection";
import type { ServerConfig } from "./config";
import type { SessionManager } from "./session-manager";

const CLIENT_MESSAGE_TYPES = new Set([
	"hello",
	"user_message",
	"permission_decision",
	"interrupt",
	"new_session",
	"resume_session",
	"rename_session",
	"list_sessions",
]);

/** Parse + minimally validate an incoming frame. Returns null for garbage. */
export function parseClientMessage(raw: string): ClientMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const type = (parsed as { type?: unknown }).type;
	if (typeof type !== "string" || !CLIENT_MESSAGE_TYPES.has(type)) return null;
	return parsed as ClientMessage;
}

export interface Transport {
	readonly writers: WriterRegistry;
	close(): Promise<void>;
}

export function startTransport(config: ServerConfig, manager: SessionManager): Transport {
	const writers = createWriterRegistry();
	const wss = new WebSocketServer({ host: config.host, port: config.port });
	let connSeq = 0;

	wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
		const id = ++connSeq;
		const ip = req.socket.remoteAddress ?? "?";
		// Lightweight observability for the testing phase. We never log message
		// content (e.g. user_message text) or the bearer token — only types/ids.
		console.log(`[occ] #${id} connected (${ip})`);

		const send = (event: BridgeEvent): void => {
			if (event.type === "error") console.warn(`[occ] #${id} -> error: ${event.message}`);
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
		};
		const connection = new Connection({ manager, token: config.token, writers, send });

		ws.on("message", (data) => {
			const msg = parseClientMessage(data.toString());
			if (!msg) {
				console.warn(`[occ] #${id} malformed frame`);
				send({ type: "error", message: "Malformed message." });
				return;
			}
			console.log(`[occ] #${id} <- ${msg.type}${"sessionId" in msg && msg.sessionId ? ` (${msg.sessionId})` : ""}`);
			const result = connection.handle(msg);
			if (result.close) {
				console.warn(`[occ] #${id} closing (auth/protocol rejected)`);
				ws.close();
			}
		});

		ws.on("close", () => {
			console.log(`[occ] #${id} disconnected`);
			connection.close();
		});
		ws.on("error", () => connection.close());
	});

	return {
		writers,
		close: () =>
			new Promise<void>((resolve, reject) => {
				wss.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
