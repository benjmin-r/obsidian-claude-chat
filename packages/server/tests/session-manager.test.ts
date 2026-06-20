import type { BridgeEvent } from "@occ/protocol";
import { SessionManager } from "../src/session-manager";
import type { ListStored, LoadHistory, RenameStored } from "../src/ports";
import { flush, makeFakeQuery } from "./fake-query";

function makeManager(opts: { listStored?: ListStored; loadHistory?: LoadHistory; renameStored?: RenameStored } = {}) {
	const fake = makeFakeQuery();
	let n = 0;
	const manager = new SessionManager(
		{
			runQuery: fake.runQuery,
			now: () => 7,
			newHandleId: () => `h${(n += 1)}`,
			listStored: opts.listStored ?? (async () => []),
			loadHistory: opts.loadHistory ?? (async () => []),
			renameStored: opts.renameStored ?? (async () => undefined),
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
});
