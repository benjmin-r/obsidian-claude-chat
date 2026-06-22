import type { BridgeEvent } from "@occ/protocol";
import { SessionManager } from "../src/session-manager";
import type {
	DeleteStored,
	DetectExternalActivity,
	ListStored,
	LoadHistory,
	RenameStored,
	SessionLastModified,
} from "../src/ports";
import { flush, makeFakeQuery } from "./fake-query";

function makeManager(
	opts: {
		listStored?: ListStored;
		loadHistory?: LoadHistory;
		renameStored?: RenameStored;
		deleteStored?: DeleteStored;
		detectExternalActivity?: DetectExternalActivity;
		sessionLastModified?: SessionLastModified;
		now?: () => number;
	} = {}
) {
	const fake = makeFakeQuery();
	let n = 0;
	const manager = new SessionManager(
		{
			runQuery: fake.runQuery,
			now: opts.now ?? (() => 7),
			newHandleId: () => `h${(n += 1)}`,
			listStored: opts.listStored ?? (async () => []),
			loadHistory: opts.loadHistory ?? (async () => []),
			renameStored: opts.renameStored ?? (async () => undefined),
			deleteStored: opts.deleteStored ?? (async () => undefined),
			detectExternalActivity: opts.detectExternalActivity,
			sessionLastModified: opts.sessionLastModified,
		},
		{ cwd: "/v", defaultModel: "claude-opus-4-8" }
	);
	return { fake, manager };
}

describe("SessionManager", () => {
	it("creates a session resolvable by its handle id", () => {
		const { manager } = makeManager();
		const actor = manager.create();
		expect(manager.get(actor.handleId)).toBe(actor);
		expect(manager.list()).toHaveLength(1);
	});

	it("uses the requested model or the default", () => {
		const { manager } = makeManager();
		expect(manager.create("claude-sonnet-4-6").model).toBe("claude-sonnet-4-6");
		expect(manager.create().model).toBe("claude-opus-4-8");
	});

	it("aliases the canonical SDK id once the query reports it", async () => {
		const { fake, manager } = makeManager();
		const actor = manager.create();
		actor.enqueue("hi");
		fake.emit({ type: "system", subtype: "init", session_id: "sdk-abc" });
		await flush();
		expect(manager.get("sdk-abc")).toBe(actor);
		expect(manager.get(actor.handleId)).toBe(actor);
	});

	it("resume returns an existing actor or reconstructs one", () => {
		const { manager } = makeManager();
		const reconstructed = manager.resume("old-session");
		expect(reconstructed.id).toBe("old-session");
		expect(manager.resume("old-session")).toBe(reconstructed);
		expect(manager.get("old-session")).toBe(reconstructed);
	});

	it("pollExternalActivity surfaces activity + staleness to attached, identified sessions", async () => {
		const { fake, manager } = makeManager({
			detectExternalActivity: () => ({ severity: "busy", pid: 5, entrypoint: "cli" }),
			sessionLastModified: async () => 10_000,
		});
		const actor = manager.create();
		const events: BridgeEvent[] = [];
		actor.subscribe((e) => events.push(e)); // attach a listener
		actor.enqueue("hi");
		fake.emit({ type: "system", subtype: "init", session_id: "sdk-1" }); // give it a real id
		await flush();
		actor.markSelfMtime(0); // 10_000 > 0 + slack → stale
		manager.pollExternalActivity();
		await flush();
		expect(events.some((e) => e.type === "external_activity" && e.severity === "busy")).toBe(true);
		expect(events.some((e) => e.type === "session_stale" && e.stale === true)).toBe(true);
	});

	it("pollExternalActivity skips sessions with no listeners or no sdk id", () => {
		const { manager } = makeManager({ detectExternalActivity: () => ({ severity: "busy" }) });
		const actor = manager.create(); // no listeners, no sdk id
		manager.pollExternalActivity();
		expect(actor.externalActivity.severity).toBe("none");
	});

	it("reapIdle releases only idle, detached, stale actors", () => {
		let now = 0;
		const { manager } = makeManager({ now: () => now });
		const idleDetached = manager.create(); // idle, no client listener
		const attached = manager.create();
		attached.subscribe(() => undefined); // a client listener keeps it alive
		const working = manager.create();
		working.enqueue("hi"); // status → working
		now = 10 * 60_000; // advance past 5 min
		manager.reapIdle(5 * 60_000);
		expect(manager.get(idleDetached.handleId)).toBeUndefined(); // reaped
		expect(manager.get(attached.handleId)).toBe(attached); // kept (has a client)
		expect(manager.get(working.handleId)).toBe(working); // kept (working)
	});

	it("reapIdle keeps actors that are not yet stale", () => {
		let now = 0;
		const { manager } = makeManager({ now: () => now });
		const a = manager.create();
		now = 60_000; // only 1 min
		manager.reapIdle(5 * 60_000);
		expect(manager.get(a.handleId)).toBe(a);
	});

	it("reloadSession drops the cached actor and reconstructs it fresh from disk", async () => {
		let loads = 0;
		const { manager } = makeManager({
			loadHistory: async () => {
				loads += 1;
				return [];
			},
		});
		const first = await manager.resumeWithHistory("sess-1");
		expect(loads).toBe(1);
		const reloaded = await manager.reloadSession("sess-1");
		expect(loads).toBe(2); // re-read disk
		expect(reloaded).not.toBe(first); // a fresh actor instance
		expect(manager.get("sess-1")).toBe(reloaded);
	});

	it("listSummaries merges active + stored, dedupes, sorts newest first", async () => {
		const { manager } = makeManager({
			listStored: async () => [
				{ sessionId: "stored-old", title: "Old", updatedAt: 1 },
				{ sessionId: "stored-new", title: "New", updatedAt: 100 },
			],
		});
		const active = manager.create();
		active.enqueue("hi"); // active updatedAt = 7
		const list = await manager.listSummaries();
		expect(list.map((s) => s.sessionId)).toEqual(["stored-new", active.id, "stored-old"]);
	});

	it("listSummaries gives an active (resumed) session its stored title, not a UUID", async () => {
		const { manager } = makeManager({
			listStored: async () => [{ sessionId: "resumed-1", title: "Renamed!", updatedAt: 50 }],
		});
		await manager.resumeWithHistory("resumed-1"); // now active; actor has no title of its own
		const list = await manager.listSummaries();
		expect(list).toHaveLength(1); // not duplicated active + stored
		expect(list[0]).toMatchObject({ sessionId: "resumed-1", title: "Renamed!" });
	});

	it("listSummaries tolerates a failing store", async () => {
		const { manager } = makeManager({
			listStored: async () => {
				throw new Error("store down");
			},
		});
		manager.create();
		await expect(manager.listSummaries()).resolves.toHaveLength(1);
	});

	it("resumeWithHistory seeds the replay buffer with mapped history", async () => {
		const { manager } = makeManager({
			loadHistory: async () => [
				{ type: "user", message: { content: "q1" } },
				{ type: "assistant", message: { content: [{ type: "text", text: "a1" }] } },
			],
		});
		const actor = await manager.resumeWithHistory("sess-x");
		const events: BridgeEvent[] = [];
		actor.subscribe((e) => events.push(e));
		expect(events.some((e) => e.type === "user_echo" && e.text === "q1")).toBe(true);
		expect(events.some((e) => e.type === "assistant_text_delta" && e.text === "a1")).toBe(true);
		await expect(manager.resumeWithHistory("sess-x")).resolves.toBe(actor);
	});

	it("renameSession delegates to the store with the configured cwd", async () => {
		const calls: Array<[string, string, string]> = [];
		const { manager } = makeManager({
			renameStored: async (cwd, id, title) => {
				calls.push([cwd, id, title]);
			},
		});
		await manager.renameSession("sess-1", "New Title");
		expect(calls).toEqual([["/v", "sess-1", "New Title"]]);
	});

	it("deleteSession removes it from the store and drops the live actor", async () => {
		const deleted: string[] = [];
		const { fake, manager } = makeManager({
			deleteStored: async (_cwd, id) => {
				deleted.push(id);
			},
		});
		const actor = await manager.resumeWithHistory("sess-del"); // now active + indexed
		actor.enqueue("hi");
		await manager.deleteSession("sess-del");
		expect(deleted).toEqual(["sess-del"]);
		expect(manager.get("sess-del")).toBeUndefined(); // dropped from index
		expect(manager.list()).toHaveLength(0); // dropped from the active set
		expect(fake.interrupted()).toBe(true); // the running query was interrupted
	});

	it("deleteSession still drops the actor when the store delete fails (not persisted)", async () => {
		const { manager } = makeManager({
			deleteStored: async () => {
				throw new Error("not found");
			},
		});
		const actor = manager.create();
		await manager.deleteSession(actor.id);
		expect(manager.get(actor.id)).toBeUndefined();
	});

	it("deleteSession on a stored-only session (no live actor) just deletes the store entry", async () => {
		const deleted: string[] = [];
		const { manager } = makeManager({
			deleteStored: async (_cwd, id) => {
				deleted.push(id);
			},
		});
		await manager.deleteSession("stored-only");
		expect(deleted).toEqual(["stored-only"]);
	});

	it("deleteSession tolerates an interrupt failure", async () => {
		const manager = new SessionManager(
			{
				runQuery: () => ({
					async *[Symbol.asyncIterator]() {
						/* immediately done */
					},
					interrupt: async () => {
						throw new Error("boom");
					},
					setPermissionMode: async () => undefined,
				}),
				now: () => 1,
				newHandleId: () => "h1",
				listStored: async () => [],
				loadHistory: async () => [],
				renameStored: async () => undefined,
				deleteStored: async () => undefined,
			},
			{ cwd: "/v", defaultModel: "m" }
		);
		const actor = manager.create();
		actor.enqueue("hi"); // starts the query so a handle exists
		await manager.deleteSession(actor.id);
		expect(manager.get(actor.id)).toBeUndefined();
	});
});
