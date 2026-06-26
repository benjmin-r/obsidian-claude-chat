import type { BridgeEvent } from "@occ/protocol";
import { BridgeClient, type BridgeClientOptions, type WsLike } from "../src/bridge-client";

class FakeWs implements WsLike {
	static instances: FakeWs[] = [];
	sent: string[] = [];
	readyState = 0;
	onopen: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;

	constructor(public url: string) {
		FakeWs.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
	fireOpen(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	deliver(obj: unknown): void {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
}

interface Harness {
	client: BridgeClient;
	events: BridgeEvent[];
	states: string[];
	scheduled: Array<{ fn: () => void; ms: number }>;
	cancel: jest.Mock;
	last(): FakeWs;
	sentFrames(): unknown[];
}

function makeClient(overrides: Partial<BridgeClientOptions> = {}): Harness {
	FakeWs.instances = [];
	const events: BridgeEvent[] = [];
	const states: string[] = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	const cancel = jest.fn();
	const client = new BridgeClient({
		url: "ws://host:8765",
		token: "secret",
		autoReconnect: true,
		reconnectDelayMs: 1000,
		createSocket: (url) => new FakeWs(url),
		onEvent: (e) => events.push(e),
		onStateChange: (s) => states.push(s),
		schedule: (fn, ms) => {
			scheduled.push({ fn, ms });
			return scheduled.length - 1;
		},
		cancel,
		...overrides,
	});
	return {
		client,
		events,
		states,
		scheduled,
		cancel,
		last: () => FakeWs.instances[FakeWs.instances.length - 1]!,
		sentFrames: () => FakeWs.instances.flatMap((w) => w.sent.map((s) => JSON.parse(s))),
	};
}

describe("BridgeClient", () => {
	it("connects and sends hello with the token on open", () => {
		const h = makeClient();
		h.client.connect();
		expect(h.states).toContain("connecting");
		h.last().fireOpen();
		expect(h.states).toContain("connected");
		expect(h.sentFrames()).toContainEqual({ type: "hello", token: "secret" });
	});

	it("includes the attach target in hello", () => {
		const h = makeClient({ attach: "sess-9" });
		h.client.connect();
		h.last().fireOpen();
		expect(h.sentFrames()).toContainEqual({ type: "hello", token: "secret", attach: "sess-9" });
	});

	it("dispatches parsed events and ignores garbage", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.last().deliver({ type: "ready", protocolVersion: 1 });
		h.last().onmessage?.({ data: "not-json" });
		h.last().onmessage?.({ data: 42 });
		expect(h.events).toContainEqual({ type: "ready", protocolVersion: 1 });
		expect(h.events.filter((e) => e.type === "ready")).toHaveLength(1);
	});

	it("refuses to send when not connected", () => {
		const h = makeClient();
		expect(h.client.userMessage("s", "hi")).toBeUndefined();
		expect(h.events).toContainEqual({ type: "error", message: "Not connected to the Claude server." });
	});

	it("sends typed frames when connected", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.client.newSession("claude-x");
		h.client.userMessage("s1", "hi");
		h.client.decide("s1", "t1", true);
		h.client.interrupt("s1");
		h.client.listSessions();
		h.client.resumeSession("s2");
		h.client.renameSession("s1", "Title");
		h.client.deleteSession("s1");
		h.client.loadOlder("s1");
		const frames = h.sentFrames();
		expect(frames).toContainEqual({ type: "new_session", model: "claude-x" });
		expect(frames).toContainEqual({ type: "user_message", sessionId: "s1", text: "hi" });
		expect(frames).toContainEqual({ type: "permission_decision", sessionId: "s1", toolUseId: "t1", allow: true });
		expect(frames).toContainEqual({ type: "interrupt", sessionId: "s1" });
		expect(frames).toContainEqual({ type: "list_sessions" });
		expect(frames).toContainEqual({ type: "resume_session", sessionId: "s2" });
		expect(frames).toContainEqual({ type: "rename_session", sessionId: "s1", title: "Title" });
		expect(frames).toContainEqual({ type: "delete_session", sessionId: "s1" });
		expect(frames).toContainEqual({ type: "load_older", sessionId: "s1" });
	});

	// the heartbeat schedules a 15000ms tick on open; reconnect schedules are the rest.
	const recon = (h: Harness) => h.scheduled.filter((s) => s.ms !== 15000);

	it("reconnects with backoff after an unexpected close", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.last().close(); // unexpected
		expect(recon(h)).toHaveLength(1);
		expect(recon(h)[0]!.ms).toBe(1000);
		recon(h)[0]!.fn(); // fire reconnect
		expect(FakeWs.instances).toHaveLength(2);
		// second failure → doubled backoff
		h.last().close();
		expect(recon(h)[1]!.ms).toBe(2000);
	});

	it("does not reconnect after an intentional disconnect", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.client.disconnect();
		expect(h.states.at(-1)).toBe("disconnected");
		expect(recon(h)).toHaveLength(0);
	});

	it("does not reconnect when autoReconnect is off", () => {
		const h = makeClient({ autoReconnect: false });
		h.client.connect();
		h.last().fireOpen();
		h.last().close();
		expect(recon(h)).toHaveLength(0);
	});

	it("pings on heartbeat and reconnects a stale (dead-but-open) socket", () => {
		let now = 0;
		const h = makeClient({ now: () => now });
		h.client.connect();
		h.last().fireOpen();
		const beat = () => h.scheduled.filter((s) => s.ms === 15000).at(-1)!.fn();
		now = 15000;
		beat(); // 15s since last frame (< 35s) → ping + reschedule
		expect(h.sentFrames()).toContainEqual({ type: "ping" });
		expect(FakeWs.instances).toHaveLength(1);
		now = 60000;
		beat(); // 60s with no inbound (> 35s) → dead socket → reconnect
		expect(FakeWs.instances).toHaveLength(2);
	});

	it("pong refreshes liveness and is not surfaced as an event", () => {
		let now = 0;
		const h = makeClient({ now: () => now });
		h.client.connect();
		h.last().fireOpen();
		now = 10000;
		h.last().deliver({ type: "pong" });
		expect(h.events.some((e) => e.type === "pong")).toBe(false);
		now = 20000;
		h.scheduled.filter((s) => s.ms === 15000).at(-1)!.fn(); // 10s since pong → still alive
		expect(FakeWs.instances).toHaveLength(1);
	});

	it("checkAlive probes a live socket and reconnects if no reply", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.client.checkAlive();
		expect(h.sentFrames()).toContainEqual({ type: "ping" });
		h.scheduled.filter((s) => s.ms === 5000).at(-1)!.fn(); // no pong arrived → reconnect
		expect(FakeWs.instances).toHaveLength(2);
	});

	it("checkAlive reconnects immediately when the socket is already closed", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.last().close(); // socket dead
		const before = FakeWs.instances.length;
		h.client.checkAlive();
		expect(FakeWs.instances.length).toBeGreaterThan(before);
	});

	it("does not surface transport errors as a Notice (the icon shows the state)", () => {
		const h = makeClient();
		h.client.connect();
		h.last().onerror?.();
		expect(h.events.some((e) => e.type === "error")).toBe(false);
	});

	it("connect() is idempotent while connecting/open (no duplicate sockets on foreground)", () => {
		const h = makeClient();
		h.client.connect(); // creates socket #1 (CONNECTING)
		h.client.connect(); // still connecting → no-op
		h.last().fireOpen(); // now OPEN
		h.client.connect(); // open → no-op
		expect(FakeWs.instances).toHaveLength(1);
	});

	it("reports connection status", () => {
		const h = makeClient();
		expect(h.client.isConnected()).toBe(false);
		h.client.connect();
		h.last().fireOpen();
		expect(h.client.isConnected()).toBe(true);
	});

	it("surfaces a clear error for a blank URL instead of constructing a socket", () => {
		const h = makeClient({ url: "   " });
		h.client.connect();
		expect(FakeWs.instances).toHaveLength(0); // never attempted `new WebSocket("")`
		expect(h.states).toEqual(["disconnected"]); // no "connecting"
		expect(h.events).toContainEqual({
			type: "error",
			message: "No server URL configured — set it in the Claude Chat settings.",
		});
		expect(h.scheduled).toHaveLength(0); // no reconnect — user must fix settings
	});

	it("surfaces an error (and does not throw) when the socket constructor throws", () => {
		const h = makeClient({
			url: "not-a-ws-url",
			createSocket: () => {
				throw new Error("invalid URL");
			},
		});
		expect(() => h.client.connect()).not.toThrow();
		expect(h.states).toEqual(["connecting", "disconnected"]);
		expect(h.events.some((e) => e.type === "error")).toBe(true);
		expect(h.scheduled).toHaveLength(0); // malformed URL won't fix itself by retrying
	});
});
