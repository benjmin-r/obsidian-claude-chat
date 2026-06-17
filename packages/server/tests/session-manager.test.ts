import { SessionManager } from "../src/session-manager";
import { flush, makeFakeQuery } from "./fake-query";

function makeManager() {
	const fake = makeFakeQuery();
	let n = 0;
	const manager = new SessionManager(
		{ runQuery: fake.runQuery, now: () => 7, newHandleId: () => `h${(n += 1)}` },
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
});
