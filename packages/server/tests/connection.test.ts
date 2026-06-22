import type { BridgeEvent, ExternalSeverity } from "@occ/protocol";
import { Connection, createWriterRegistry } from "../src/connection";
import { SessionManager } from "../src/session-manager";
import { flush, makeFakeQuery } from "./fake-query";

function setup() {
	const fake = makeFakeQuery();
	let n = 0;
	const manager = new SessionManager(
		{
			runQuery: fake.runQuery,
			now: () => 1,
			newHandleId: () => `h${(n += 1)}`,
			listStored: async () => [],
			loadHistory: async () => [],
			renameStored: async () => undefined,
			deleteStored: async () => undefined,
		},
		{ cwd: "/v", defaultModel: "m" }
	);
	const writers = createWriterRegistry();
	const mkConn = () => {
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		return { conn, sent };
	};
	return { fake, manager, writers, mkConn };
}

function sessionIdFrom(sent: BridgeEvent[]): string {
	const status = sent.find((e) => e.type === "session_status");
	if (!status || status.type !== "session_status") throw new Error("no status");
	return status.sessionId;
}

describe("Connection auth", () => {
	it("rejects a bad token and asks to close", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		expect(conn.handle({ type: "hello", token: "wrong" })).toEqual({ close: true });
		expect(sent).toEqual([{ type: "error", message: "Invalid token." }]);
	});

	it("rejects messages before hello", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		expect(conn.handle({ type: "list_sessions" })).toEqual({ close: true });
		expect(sent[0]).toMatchObject({ type: "error" });
	});

	it("accepts a good token and replies ready", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		expect(conn.handle({ type: "hello", token: "secret" })).toEqual({});
		expect(sent[0]).toEqual({ type: "ready", protocolVersion: 1 });
	});
});

describe("Connection session flow", () => {
	it("creates a session and marks the creator as writer", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session", model: "m" });
		const status = sent.find((e) => e.type === "session_status");
		expect(status).toMatchObject({ type: "session_status", isWriter: true, status: "idle" });
	});

	it("enqueues a user message and reports working", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(sent);
		conn.handle({ type: "user_message", sessionId, text: "hi" });
		expect(sent.some((e) => e.type === "session_status" && e.status === "working")).toBe(true);
	});

	it("errors on an unknown session id", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "user_message", sessionId: "ghost", text: "hi" });
		expect(sent.some((e) => e.type === "error" && e.message.includes("ghost"))).toBe(true);
	});

	it("lists sessions (active merged with stored)", async () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		conn.handle({ type: "list_sessions" });
		await flush();
		const list = sent.find((e) => e.type === "sessions_list");
		expect(list).toMatchObject({ type: "sessions_list" });
		expect((list as { sessions: unknown[] }).sessions).toHaveLength(1);
	});

	it("resumes a session and replays its stored history", async () => {
		const fake = makeFakeQuery();
		let n = 0;
		const manager = new SessionManager(
			{
				runQuery: fake.runQuery,
				now: () => 1,
				newHandleId: () => `h${(n += 1)}`,
				listStored: async () => [{ sessionId: "old-1", title: "Old chat", updatedAt: 5 }],
				loadHistory: async () => [
					{ type: "user", message: { content: "earlier question" } },
					{ type: "assistant", message: { content: [{ type: "text", text: "earlier answer" }] } },
				],
				renameStored: async () => undefined,
				deleteStored: async () => undefined,
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const writers = createWriterRegistry();
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "resume_session", sessionId: "old-1" });
		await flush();
		await flush();
		expect(sent.some((e) => e.type === "user_echo" && e.text === "earlier question")).toBe(true);
		expect(sent.some((e) => e.type === "assistant_text_delta" && e.text === "earlier answer")).toBe(true);
	});

	it("renames a session and replies with a refreshed list", async () => {
		const fake = makeFakeQuery();
		let n = 0;
		const renamed: Array<[string, string]> = [];
		const manager = new SessionManager(
			{
				runQuery: fake.runQuery,
				now: () => 1,
				newHandleId: () => `h${(n += 1)}`,
				listStored: async () => [{ sessionId: "s1", title: "renamed!", updatedAt: 9 }],
				loadHistory: async () => [],
				renameStored: async (_cwd, id, title) => {
					renamed.push([id, title]);
				},
				deleteStored: async () => undefined,
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const writers = createWriterRegistry();
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "rename_session", sessionId: "s1", title: "renamed!" });
		await flush();
		await flush();
		expect(renamed).toEqual([["s1", "renamed!"]]);
		expect(
			sent.some((e) => e.type === "sessions_list" && e.sessions.some((s) => s.title === "renamed!"))
		).toBe(true);
	});

	it("deletes a session and replies with a refreshed list", async () => {
		const fake = makeFakeQuery();
		let n = 0;
		const deleted: string[] = [];
		let remaining = [{ sessionId: "d1", title: "Doomed", updatedAt: 9 }];
		const manager = new SessionManager(
			{
				runQuery: fake.runQuery,
				now: () => 1,
				newHandleId: () => `h${(n += 1)}`,
				listStored: async () => remaining,
				loadHistory: async () => [],
				renameStored: async () => undefined,
				deleteStored: async (_cwd, id) => {
					deleted.push(id);
					remaining = remaining.filter((s) => s.sessionId !== id);
				},
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const writers = createWriterRegistry();
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "delete_session", sessionId: "d1" });
		await flush();
		await flush();
		expect(deleted).toEqual(["d1"]);
		const list = sent.filter((e) => e.type === "sessions_list").at(-1);
		expect(list && list.type === "sessions_list" && list.sessions).toEqual([]);
	});

	it("deletes the current session and detaches from it", async () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(sent);
		conn.handle({ type: "delete_session", sessionId });
		await flush();
		await flush();
		expect(sent.some((e) => e.type === "sessions_list")).toBe(true);
	});

	it("pages older history on load_older", async () => {
		const fake = makeFakeQuery();
		let n = 0;
		const many = Array.from({ length: 70 }, (_, i) => ({ type: "user" as const, message: { content: `m${i}` } }));
		const manager = new SessionManager(
			{
				runQuery: fake.runQuery,
				now: () => 1,
				newHandleId: () => `h${(n += 1)}`,
				listStored: async () => [],
				loadHistory: async () => many,
				renameStored: async () => undefined,
				deleteStored: async () => undefined,
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const writers = createWriterRegistry();
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "resume_session", sessionId: "sess-big" });
		await flush();
		await flush();
		expect(sent.some((e) => e.type === "session_status" && e.hasOlderHistory)).toBe(true);

		sent.length = 0;
		conn.handle({ type: "load_older", sessionId: "sess-big" });
		const page = sent.find((e) => e.type === "history_page");
		expect(page && page.type === "history_page" && page.events.length).toBe(30); // 70 - 40 older; first page of 30
		expect(page && page.type === "history_page" && page.hasMore).toBe(true);
	});

	it("enforces single-writer across mirrored clients and hands off on close", () => {
		const { mkConn } = setup();
		const a = mkConn();
		const b = mkConn();
		a.conn.handle({ type: "hello", token: "secret" });
		a.conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(a.sent);

		b.conn.handle({ type: "hello", token: "secret", attach: sessionId });
		b.conn.handle({ type: "user_message", sessionId, text: "mine" });
		expect(b.sent.some((e) => e.type === "error" && /active writer/.test(e.message))).toBe(true);

		// writer A leaves → B can now claim it
		a.conn.close();
		b.conn.handle({ type: "user_message", sessionId, text: "now mine" });
		expect(b.sent.some((e) => e.type === "session_status" && e.status === "working" && e.isWriter)).toBe(true);
	});

	it("routes a permission decision to the actor", async () => {
		const { fake, manager, mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(sent);
		conn.handle({ type: "user_message", sessionId, text: "delete it" });

		const decision = fake.options()!.canUseTool("Bash", { command: "rm -rf x" }, { toolUseID: "tt" });
		expect(sent.some((e) => e.type === "permission_request" && e.toolUseId === "tt")).toBe(true);

		conn.handle({ type: "permission_decision", sessionId, toolUseId: "tt", allow: true });
		await expect(decision).resolves.toMatchObject({ behavior: "allow" });
		expect(manager.get(sessionId)).toBeDefined();
	});

	it("routes set_permission_mode to the actor", async () => {
		const { fake, mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(sent);
		conn.handle({ type: "user_message", sessionId, text: "go" }); // start the query (handle exists)
		conn.handle({ type: "set_permission_mode", sessionId, mode: "acceptEdits" });
		await flush();
		expect(fake.modeSet()).toBe("acceptEdits");
	});

	it("guards sends: blocks stale (no override) and external-busy (overridable with force)", async () => {
		let mtime = 100;
		let severity: ExternalSeverity = "none";
		const fake = makeFakeQuery();
		let n = 0;
		const manager = new SessionManager(
			{
				runQuery: fake.runQuery,
				now: () => 1,
				newHandleId: () => `h${(n += 1)}`,
				listStored: async () => [],
				loadHistory: async () => [],
				renameStored: async () => undefined,
				deleteStored: async () => undefined,
				detectExternalActivity: () => ({ severity }),
				sessionLastModified: async () => mtime,
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const writers = createWriterRegistry();
		const sent: BridgeEvent[] = [];
		const conn = new Connection({ manager, token: "secret", writers, send: (e) => sent.push(e) });
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "resume_session", sessionId: "sess-1" }); // resumed actor has an SDK id + mtime baseline 100
		await flush();
		await flush();

		// stale: on-disk advanced past the baseline → blocked, never enqueued, no override.
		mtime = 1_000_000;
		sent.length = 0;
		conn.handle({ type: "user_message", sessionId: "sess-1", text: "a" });
		await flush();
		expect(sent.some((e) => e.type === "send_blocked" && e.reason === "stale")).toBe(true);
		expect(fake.options()).toBeUndefined(); // query never started

		// not stale but externally busy → blocked without force.
		mtime = 100;
		severity = "busy";
		sent.length = 0;
		conn.handle({ type: "user_message", sessionId: "sess-1", text: "b" });
		await flush();
		expect(sent.some((e) => e.type === "send_blocked" && e.reason === "external_busy")).toBe(true);
		expect(fake.options()).toBeUndefined();

		// with force → enqueued (query starts).
		conn.handle({ type: "user_message", sessionId: "sess-1", text: "b", force: true });
		await flush();
		expect(fake.options()).toBeDefined();
	});

	it("forwards interrupt", () => {
		const { fake, mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret" });
		conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(sent);
		conn.handle({ type: "user_message", sessionId, text: "go" });
		conn.handle({ type: "interrupt", sessionId });
		expect(fake.interrupted()).toBe(true);
	});

	it("attaches to an existing session named in hello", () => {
		const { mkConn } = setup();
		const a = mkConn();
		a.conn.handle({ type: "hello", token: "secret" });
		a.conn.handle({ type: "new_session" });
		const sessionId = sessionIdFrom(a.sent);

		const b = mkConn();
		b.conn.handle({ type: "hello", token: "secret", attach: sessionId });
		expect(b.sent.some((e) => e.type === "session_status" && e.sessionId === sessionId)).toBe(true);
	});

	it("errors when hello attaches to a missing session", () => {
		const { mkConn } = setup();
		const { conn, sent } = mkConn();
		conn.handle({ type: "hello", token: "secret", attach: "nope" });
		expect(sent.some((e) => e.type === "error" && e.message.includes("nope"))).toBe(true);
	});
});
