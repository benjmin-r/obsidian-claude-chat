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
		const frames = h.sentFrames();
		expect(frames).toContainEqual({ type: "new_session", model: "claude-x" });
		expect(frames).toContainEqual({ type: "user_message", sessionId: "s1", text: "hi" });
		expect(frames).toContainEqual({ type: "permission_decision", sessionId: "s1", toolUseId: "t1", allow: true });
		expect(frames).toContainEqual({ type: "interrupt", sessionId: "s1" });
		expect(frames).toContainEqual({ type: "list_sessions" });
		expect(frames).toContainEqual({ type: "resume_session", sessionId: "s2" });
	});

	it("reconnects with backoff after an unexpected close", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.last().close(); // unexpected
		expect(h.scheduled).toHaveLength(1);
		expect(h.scheduled[0]!.ms).toBe(1000);
		h.scheduled[0]!.fn(); // fire reconnect
		expect(FakeWs.instances).toHaveLength(2);
		// second failure → doubled backoff
		h.last().close();
		expect(h.scheduled[1]!.ms).toBe(2000);
	});

	it("does not reconnect after an intentional disconnect", () => {
		const h = makeClient();
		h.client.connect();
		h.last().fireOpen();
		h.client.disconnect();
		expect(h.states.at(-1)).toBe("disconnected");
		expect(h.scheduled).toHaveLength(0);
	});

	it("does not reconnect when autoReconnect is off", () => {
		const h = makeClient({ autoReconnect: false });
		h.client.connect();
		h.last().fireOpen();
		h.last().close();
		expect(h.scheduled).toHaveLength(0);
	});

	it("emits an error on socket error", () => {
		const h = makeClient();
		h.client.connect();
		h.last().onerror?.();
		expect(h.events).toContainEqual({ type: "error", message: "WebSocket error." });
	});

	it("reports connection status", () => {
		const h = makeClient();
		expect(h.client.isConnected()).toBe(false);
		h.client.connect();
		h.last().fireOpen();
		expect(h.client.isConnected()).toBe(true);
	});
});
