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
	/** injected clock (testability); defaults to Date.now. */
	now?: () => number;
}

const CONNECTING = 0;
const OPEN = 1;
/** Heartbeat cadence + how long without ANY inbound frame counts as a dead socket. */
const HEARTBEAT_MS = 15_000;
const STALE_MS = 35_000;
/** After an active probe (checkAlive), wait this long for a reply before reconnecting. */
const PROBE_MS = 5_000;

export class BridgeClient {
	private ws: WsLike | undefined;
	private intentionalClose = false;
	private reconnectHandle: unknown;
	private heartbeatHandle: unknown;
	private attempts = 0;
	private attachTarget: string | undefined;
	/** epoch ms of the last inbound frame; a stale value means the socket is dead. */
	private lastSeenAt = 0;
	private probePending = false;

	constructor(private readonly opts: BridgeClientOptions) {
		this.attachTarget = opts.attach;
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	connect(): void {
		// Idempotent: a foreground can fire visibilitychange + focus + online together;
		// don't spawn duplicate sockets if one is already connecting/open.
		const rs = this.ws?.readyState;
		if (rs === CONNECTING || rs === OPEN) return;
		this.intentionalClose = false;
		this.cancelReconnect();
		this.stopHeartbeat();
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
		this.stopHeartbeat();
		this.ws?.close();
		this.ws = undefined;
		this.opts.onStateChange("disconnected");
	}

	/**
	 * Active liveness probe — call when the app returns to the foreground. If the
	 * socket is already dead, reconnect immediately; otherwise ping and reconnect if
	 * no reply arrives (catches "stale-open" sockets the OS killed without a close).
	 */
	checkAlive(): void {
		const rs = this.ws?.readyState;
		if (rs === CONNECTING) return; // already (re)connecting — let it finish
		if (rs !== OPEN) {
			this.connect(); // dead / never opened → reconnect
			return;
		}
		if (this.probePending) return; // one probe at a time
		this.probePending = true;
		const before = this.lastSeenAt;
		this.ws?.send(JSON.stringify({ type: "ping" }));
		const schedule = this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		schedule(() => {
			this.probePending = false;
			if (this.isConnected() && this.lastSeenAt === before) this.forceReconnect();
		}, PROBE_MS);
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

	userMessage(sessionId: string, text: string): void {
		this.send({ type: "user_message", sessionId, text });
	}

	/** Detach + release the session server-side (clean CLI hand-off). */
	closeSession(sessionId: string): void {
		this.send({ type: "close_session", sessionId });
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
		this.lastSeenAt = this.now();
		const hello: ClientMessage = { type: "hello", token: this.opts.token };
		if (this.attachTarget) hello.attach = this.attachTarget;
		this.ws?.send(JSON.stringify(hello));
		this.opts.onStateChange("connected");
		this.startHeartbeat();
	}

	private onMessage(data: unknown): void {
		if (typeof data !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const type = (parsed as { type?: unknown }).type;
		if (typeof type !== "string") return;
		this.lastSeenAt = this.now(); // any inbound frame proves the socket is alive
		if (type === "pong") return; // liveness only — not a UI event
		this.opts.onEvent(parsed as BridgeEvent);
	}

	private onError(): void {
		// Transport errors are noise — the connection icon already shows the state, and
		// `onClose` + the heartbeat drive recovery. Don't spam the user with a Notice.
	}

	private onClose(): void {
		this.ws = undefined;
		this.stopHeartbeat();
		this.opts.onStateChange("disconnected");
		if (this.intentionalClose || !this.opts.autoReconnect) return;
		this.scheduleReconnect();
	}

	// -- heartbeat ------------------------------------------------------------

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const schedule = this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.heartbeatHandle = schedule(() => this.heartbeat(), HEARTBEAT_MS);
	}

	private heartbeat(): void {
		if (!this.isConnected()) return; // onClose/reconnect owns the disconnected case
		if (this.now() - this.lastSeenAt > STALE_MS) {
			this.forceReconnect(); // dead-but-open socket
			return;
		}
		this.ws?.send(JSON.stringify({ type: "ping" })); // server pong refreshes lastSeenAt
		this.startHeartbeat();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatHandle === undefined) return;
		const cancel = this.opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		cancel(this.heartbeatHandle);
		this.heartbeatHandle = undefined;
	}

	/** Drop a (possibly dead-but-open) socket and reconnect from scratch. */
	private forceReconnect(): void {
		try {
			this.ws?.close();
		} catch {
			// already dead
		}
		this.ws = undefined;
		this.opts.onStateChange("disconnected");
		this.connect();
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
