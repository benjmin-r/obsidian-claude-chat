/**
 * WebSocket bridge client. DOM/WebSocket-only (mobile-safe). The socket
 * constructor and the reconnect scheduler are injected so the reconnect/backoff
 * and event-mapping logic is unit-testable against a fake socket with no real
 * network and no timers.
 */

import type { BridgeEvent, ClientMessage, PermissionMode } from "@occ/protocol";

export interface WsLike {
	send(data: string): void;
	close(): void;
	readyState: number;
	onopen: ((ev?: unknown) => void) | null;
	onclose: ((ev?: unknown) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export interface BridgeClientOptions {
	url: string;
	token: string;
	autoReconnect: boolean;
	reconnectDelayMs: number;
	/** session id to (re)attach to on connect, if any. */
	attach?: string;
	createSocket: WsFactory;
	onEvent: (event: BridgeEvent) => void;
	onStateChange: (state: "disconnected" | "connecting" | "connected") => void;
	/** injected so reconnect timing is testable; defaults provided by caller. */
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
}

const OPEN = 1;

export class BridgeClient {
	private ws: WsLike | undefined;
	private intentionalClose = false;
	private reconnectHandle: unknown;
	private attempts = 0;
	private attachTarget: string | undefined;

	constructor(private readonly opts: BridgeClientOptions) {
		this.attachTarget = opts.attach;
	}

	connect(): void {
		this.intentionalClose = false;
		this.cancelReconnect();
		this.opts.onStateChange("connecting");
		const ws = this.opts.createSocket(this.opts.url);
		this.ws = ws;
		ws.onopen = () => this.onOpen();
		ws.onclose = () => this.onClose();
		ws.onerror = () => this.onError();
		ws.onmessage = (ev) => this.onMessage(ev.data);
	}

	disconnect(): void {
		this.intentionalClose = true;
		this.cancelReconnect();
		this.ws?.close();
		this.ws = undefined;
		this.opts.onStateChange("disconnected");
	}

	/** Remember a session to attach to on the next (re)connect. */
	setAttachTarget(sessionId: string | undefined): void {
		this.attachTarget = sessionId;
	}

	isConnected(): boolean {
		return this.ws?.readyState === OPEN;
	}

	// -- outbound -------------------------------------------------------------

	newSession(model?: string): void {
		this.send({ type: "new_session", model });
	}

	resumeSession(sessionId: string, reload = false): void {
		this.attachTarget = sessionId;
		this.send({ type: "resume_session", sessionId, ...(reload ? { reload: true } : {}) });
	}

	renameSession(sessionId: string, title: string): void {
		this.send({ type: "rename_session", sessionId, title });
	}

	deleteSession(sessionId: string): void {
		this.send({ type: "delete_session", sessionId });
	}

	loadOlder(sessionId: string): void {
		this.send({ type: "load_older", sessionId });
	}

	setPermissionMode(sessionId: string, mode: PermissionMode): void {
		this.send({ type: "set_permission_mode", sessionId, mode });
	}

	userMessage(sessionId: string, text: string, force = false): void {
		this.send({ type: "user_message", sessionId, text, ...(force ? { force: true } : {}) });
	}

	decide(sessionId: string, toolUseId: string, allow: boolean, message?: string): void {
		this.send({ type: "permission_decision", sessionId, toolUseId, allow, message });
	}

	interrupt(sessionId: string): void {
		this.send({ type: "interrupt", sessionId });
	}

	listSessions(): void {
		this.send({ type: "list_sessions" });
	}

	/** @returns true if the frame was sent (socket open), false otherwise. */
	send(msg: ClientMessage): boolean {
		if (!this.ws || this.ws.readyState !== OPEN) {
			this.opts.onEvent({ type: "error", message: "Not connected to the Claude server." });
			return false;
		}
		this.ws.send(JSON.stringify(msg));
		return true;
	}

	// -- socket handlers ------------------------------------------------------

	private onOpen(): void {
		this.attempts = 0;
		const hello: ClientMessage = { type: "hello", token: this.opts.token };
		if (this.attachTarget) hello.attach = this.attachTarget;
		this.ws?.send(JSON.stringify(hello));
		this.opts.onStateChange("connected");
	}

	private onMessage(data: unknown): void {
		if (typeof data !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
			this.opts.onEvent(parsed as BridgeEvent);
		}
	}

	private onError(): void {
		this.opts.onEvent({ type: "error", message: "WebSocket error." });
	}

	private onClose(): void {
		this.ws = undefined;
		this.opts.onStateChange("disconnected");
		if (this.intentionalClose || !this.opts.autoReconnect) return;
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const schedule = this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.attempts += 1;
		// capped exponential backoff
		const delay = Math.min(this.opts.reconnectDelayMs * 2 ** (this.attempts - 1), 30_000);
		this.reconnectHandle = schedule(() => this.connect(), delay);
	}

	private cancelReconnect(): void {
		if (this.reconnectHandle === undefined) return;
		const cancel = this.opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		cancel(this.reconnectHandle);
		this.reconnectHandle = undefined;
	}
}
