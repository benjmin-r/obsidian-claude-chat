import type { BridgeEvent, SdkMessage } from "@occ/protocol";
import { SessionActor } from "../src/session-actor";
import { flush, makeFakeQuery } from "./fake-query";

function collect(actor: SessionActor): BridgeEvent[] {
	const events: BridgeEvent[] = [];
	actor.subscribe((e) => events.push(e));
	return events;
}

const textDelta = (text: string): SdkMessage => ({
	type: "stream_event",
	event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

function makeActor() {
	const fake = makeFakeQuery();
	const actor = new SessionActor({ runQuery: fake.runQuery, now: () => 1000 }, { handleId: "h1", cwd: "/v", model: "claude-opus-4-8" });
	return { fake, actor };
}

describe("SessionActor", () => {
	it("starts the query lazily and reports working on enqueue", () => {
		const { fake, actor } = makeActor();
		const events = collect(actor);
		expect(fake.options()).toBeUndefined();
		actor.enqueue("hello");
		expect(fake.options()).toBeDefined();
		expect(actor.status).toBe("working");
		expect(events.some((e) => e.type === "session_status" && e.status === "working")).toBe(true);
	});

	it("pushes user turns into the streaming prompt", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("first");
		const it = fake.prompt()![Symbol.asyncIterator]();
		expect(await it.next()).toEqual({ value: { type: "user", message: { role: "user", content: "first" } }, done: false });
	});

	it("streams text deltas and records them for replay", async () => {
		const { fake, actor } = makeActor();
		const events = collect(actor);
		actor.enqueue("hi");
		fake.emit(textDelta("Hel"));
		fake.emit(textDelta("lo"));
		await flush();
		const deltas = events.filter((e) => e.type === "assistant_text_delta");
		expect(deltas).toEqual([
			{ type: "assistant_text_delta", sessionId: "h1", text: "Hel" },
			{ type: "assistant_text_delta", sessionId: "h1", text: "lo" },
		]);
		// late subscriber replays the buffered transcript
		const late = collect(actor);
		expect(late.filter((e) => e.type === "assistant_text_delta")).toHaveLength(2);
	});

	it("adopts the canonical SDK session id and re-broadcasts status", async () => {
		const { fake, actor } = makeActor();
		const events = collect(actor);
		actor.enqueue("hi");
		fake.emit({ type: "system", subtype: "init", session_id: "sdk-xyz" });
		await flush();
		expect(actor.id).toBe("sdk-xyz");
		expect(actor.sdkSessionId).toBe("sdk-xyz");
		expect(events.some((e) => e.type === "session_status" && e.sessionId === "sdk-xyz")).toBe(true);
	});

	it("goes idle on result", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		fake.emit({ type: "result", subtype: "success", is_error: false });
		await flush();
		expect(actor.status).toBe("idle");
	});

	it("auto-allows non-destructive tools", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		const result = await fake.options()!.canUseTool("Read", { file_path: "/x" }, {});
		expect(result).toEqual({ behavior: "allow", updatedInput: { file_path: "/x" } });
		expect(actor.status).toBe("working");
	});

	it("routes destructive tools through a permission round-trip (allow)", async () => {
		const { fake, actor } = makeActor();
		const events = collect(actor);
		actor.enqueue("hi");
		const decision = fake.options()!.canUseTool("Bash", { command: "rm -rf build" }, { toolUseID: "t1" });
		expect(actor.status).toBe("awaiting_permission");
		const req = events.find((e) => e.type === "permission_request");
		expect(req).toMatchObject({ type: "permission_request", toolUseId: "t1", name: "Bash" });

		actor.decidePermission("t1", true);
		await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
		expect(actor.status).toBe("working");
	});

	it("routes destructive tools through a permission round-trip (deny)", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		const decision = fake.options()!.canUseTool("Bash", { command: "rm x" }, { toolUseID: "t2" });
		actor.decidePermission("t2", false, "no thanks");
		await expect(decision).resolves.toEqual({ behavior: "deny", message: "no thanks" });
	});

	it("re-surfaces a still-pending permission request to a late subscriber", () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		void fake.options()!.canUseTool("Bash", { command: "rm x" }, { toolUseID: "t3" });
		const late = collect(actor);
		expect(late.some((e) => e.type === "permission_request" && e.toolUseId === "t3")).toBe(true);
		expect(late.some((e) => e.type === "session_status" && e.status === "awaiting_permission")).toBe(true);
	});

	it("ignores decisions for unknown tool ids", () => {
		const { actor } = makeActor();
		actor.enqueue("hi");
		expect(() => actor.decidePermission("nope", true)).not.toThrow();
	});

	it("caps the replay buffer", async () => {
		const fake = makeFakeQuery();
		const actor = new SessionActor(
			{ runQuery: fake.runQuery, now: () => 1 },
			{ handleId: "h", cwd: "/v", model: "m", bufferLimit: 3 }
		);
		actor.enqueue("hi");
		for (let i = 0; i < 10; i++) fake.emit(textDelta(`d${i}`));
		await flush();
		const late = collect(actor);
		expect(late.filter((e) => e.type === "assistant_text_delta")).toHaveLength(3);
	});

	it("interrupts the underlying query", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		await actor.interrupt();
		expect(fake.interrupted()).toBe(true);
	});

	it("broadcasts external activity on change, ignores no-ops, and re-emits on attach", () => {
		const { actor } = makeActor();
		const events = collect(actor);
		actor.setExternalActivity({ severity: "busy", pid: 9, entrypoint: "cli" });
		expect(events.some((e) => e.type === "external_activity" && e.severity === "busy")).toBe(true);
		const n = events.length;
		actor.setExternalActivity({ severity: "busy", pid: 9, entrypoint: "cli" }); // identical → no-op
		expect(events.length).toBe(n);
		const late = collect(actor); // re-emitted to a fresh subscriber
		expect(late.some((e) => e.type === "external_activity" && e.severity === "busy")).toBe(true);
	});

	it("broadcasts staleness on change and re-emits on attach", () => {
		const { actor } = makeActor();
		const events = collect(actor);
		actor.setStale(true);
		expect(events.some((e) => e.type === "session_stale" && e.stale === true)).toBe(true);
		const late = collect(actor);
		expect(late.some((e) => e.type === "session_stale" && e.stale === true)).toBe(true);
	});

	it("resets the staleness baseline when our own turn completes", async () => {
		const { fake, actor } = makeActor();
		actor.markSelfMtime(0);
		actor.setStale(true);
		actor.enqueue("hi");
		fake.emit({ type: "result", subtype: "success", is_error: false });
		await flush();
		expect(actor.stale).toBe(false);
		expect(actor.selfMtime).toBe(1000); // now()
	});

	it("tracks listenerCount", () => {
		const { actor } = makeActor();
		expect(actor.listenerCount).toBe(0);
		const off = actor.subscribe(() => undefined);
		expect(actor.listenerCount).toBe(1);
		off();
		expect(actor.listenerCount).toBe(0);
	});

	it("starts in default mode and changes permission mode at runtime", async () => {
		const { fake, actor } = makeActor();
		actor.enqueue("hi");
		expect(fake.options()!.permissionMode).toBe("default");
		expect(actor.statusEvent().permissionMode).toBe("default");
		await actor.setPermissionMode("acceptEdits");
		expect(fake.modeSet()).toBe("acceptEdits");
		expect(actor.statusEvent().permissionMode).toBe("acceptEdits");
	});

	it("can set the permission mode before the query has started", async () => {
		const { actor } = makeActor();
		await actor.setPermissionMode("acceptEdits"); // no handle yet
		expect(actor.statusEvent().permissionMode).toBe("acceptEdits");
	});

	it("surfaces an error (no crash) when the mode change is rejected", async () => {
		const events: BridgeEvent[] = [];
		const actor = new SessionActor(
			{
				runQuery: () => ({
					async *[Symbol.asyncIterator]() {
						/* idle */
					},
					interrupt: async () => undefined,
					setPermissionMode: async () => {
						throw new Error("not allowed");
					},
				}),
				now: () => 1,
			},
			{ handleId: "h", cwd: "/v", model: "m" }
		);
		actor.subscribe((e) => events.push(e));
		actor.enqueue("hi"); // start so a handle exists
		await actor.setPermissionMode("acceptEdits");
		expect(events.some((e) => e.type === "error" && /Couldn't change mode/.test(e.message))).toBe(true);
		expect(actor.statusEvent().permissionMode).toBe("default"); // unchanged on failure
	});

	it("emits an error event and goes idle when the query throws", async () => {
		const events: BridgeEvent[] = [];
		const actor = new SessionActor(
			{
				runQuery: () => ({
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw new Error("boom");
					},
					interrupt: async () => undefined,
					setPermissionMode: async () => undefined,
				}),
				now: () => 1,
			},
			{ handleId: "h", cwd: "/v", model: "m" }
		);
		actor.subscribe((e) => events.push(e));
		actor.enqueue("hi");
		await flush();
		expect(events.some((e) => e.type === "error" && e.message === "boom")).toBe(true);
		expect(actor.status).toBe("idle");
	});

	it("unsubscribe stops further events", async () => {
		const { fake, actor } = makeActor();
		const events: BridgeEvent[] = [];
		const unsub = actor.subscribe((e) => events.push(e));
		actor.enqueue("hi");
		unsub();
		const before = events.length;
		fake.emit(textDelta("more"));
		await flush();
		expect(events.length).toBe(before);
	});

	it("seeds only the last page of history and pages older on demand", () => {
		const { actor } = makeActor();
		const events = Array.from({ length: 75 }, (_, i) => ({ type: "user_echo" as const, sessionId: "h1", text: `m${i}` }));
		actor.seedHistory(events);
		expect(actor.statusEvent().hasOlderHistory).toBe(true);

		const replayed: BridgeEvent[] = [];
		actor.subscribe((e) => replayed.push(e));
		const echoed = replayed.filter((e) => e.type === "user_echo");
		expect(echoed).toHaveLength(30); // last page only
		expect(echoed[0]).toMatchObject({ text: "m45" }); // 75 - 30

		const page1 = actor.loadOlderPage();
		expect(page1.events).toHaveLength(30);
		expect(page1.events.at(-1)).toMatchObject({ text: "m44" });
		expect(page1.hasMore).toBe(true);

		const page2 = actor.loadOlderPage();
		expect(page2.events).toHaveLength(15);
		expect(page2.hasMore).toBe(false);
	});

	it("summarises itself", () => {
		const { actor } = makeActor();
		actor.enqueue("hi");
		expect(actor.summary()).toMatchObject({ sessionId: "h1", model: "claude-opus-4-8", status: "working", cwd: "/v", messageCount: 1 });
	});
});
