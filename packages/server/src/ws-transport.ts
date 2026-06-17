/**
 * Thin I/O shell: binds a `ws` WebSocketServer to the Tailscale IP and pumps
 * parsed frames through a per-socket `Connection`. The protocol logic lives in
 * `connection.ts`; this module only does socket plumbing + JSON framing.
 */

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

	wss.on("connection", (ws: WebSocket) => {
		const send = (event: BridgeEvent): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
		};
		const connection = new Connection({ manager, token: config.token, writers, send });

		ws.on("message", (data) => {
			const msg = parseClientMessage(data.toString());
			if (!msg) {
				send({ type: "error", message: "Malformed message." });
				return;
			}
			const result = connection.handle(msg);
			if (result.close) ws.close();
		});

		ws.on("close", () => connection.close());
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
