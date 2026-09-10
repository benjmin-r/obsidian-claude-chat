import type { BridgeEvent } from "@occ/protocol";
import {
	appendUserMessage,
	applyEvent,
	clearPermission,
	groupActivity,
	initialState,
	setConnection,
	summarizeActivity,
	type ChatItem,
	type ChatState,
} from "../src/view-model";

const SID = "s1";

function reduce(events: BridgeEvent[], start: ChatState = initialState("claude-opus-4-8")): ChatState {
	return events.reduce(applyEvent, start);
}

describe("view-model", () => {
	it("starts disconnected and idle", () => {
		const s = initialState("m");
		expect(s).toMatchObject({ connection: "disconnected", status: "idle", items: [], model: "m" });
	});

	it("ready marks connection connected", () => {
		expect(applyEvent(initialState("m"), { type: "ready", protocolVersion: 1 }).connection).toBe("connected");
	});

	it("accumulates consecutive assistant text deltas into one bubble", () => {
		const s = reduce([
			{ type: "assistant_text_delta", sessionId: SID, text: "Hel" },
			{ type: "assistant_text_delta", sessionId: SID, text: "lo " },
			{ type: "assistant_text_delta", sessionId: SID, text: "world" },
		]);
		expect(s.items).toEqual([{ kind: "assistant", text: "Hello world" }]);
	});

	it("appends a historical user echo as a user bubble", () => {
		const s = applyEvent(initialState("m"), { type: "user_echo", sessionId: SID, text: "old question" });
		expect(s.items.at(-1)).toEqual({ kind: "user", text: "old question" });
	});

	it("carries a deep-link anchor id from history events (user + assistant)", () => {
		const s = reduce([
			{ type: "user_echo", sessionId: SID, text: "q", messageId: "u-1" },
			{ type: "assistant_text_delta", sessionId: SID, text: "a", messageId: "a-1" },
		]);
		expect(s.items).toEqual([
			{ kind: "user", text: "q", id: "u-1" },
			{ kind: "assistant", text: "a", id: "a-1" },
		]);
	});

	it("message_anchor tags the streamed (id-less) bubble of its kind", () => {
		const s = reduce([
			{ type: "thinking_delta", sessionId: SID, text: "hmm" },
			{ type: "assistant_text_delta", sessionId: SID, text: "Hello " },
			{ type: "assistant_text_delta", sessionId: SID, text: "world" },
			{ type: "message_anchor", sessionId: SID, messageId: "think-uuid", kind: "thinking" },
			{ type: "message_anchor", sessionId: SID, messageId: "text-uuid", kind: "assistant" },
		]);
		expect(s.items).toEqual([
			{ kind: "thinking", text: "hmm", id: "think-uuid" },
			{ kind: "assistant", text: "Hello world", id: "text-uuid" },
		]);
	});

	it("message_anchor only fills the nearest id-less bubble (doesn't overwrite)", () => {
		const s = reduce([
			{ type: "assistant_text_delta", sessionId: SID, text: "first", messageId: "already" },
			{ type: "tool_use", sessionId: SID, toolUseId: "t1", name: "Read", input: {} },
			{ type: "assistant_text_delta", sessionId: SID, text: "second" }, // id-less (live)
			{ type: "message_anchor", sessionId: SID, messageId: "late", kind: "assistant" },
		]);
		expect(s.items[0]).toEqual({ kind: "assistant", text: "first", id: "already" });
		expect(s.items.at(-1)).toEqual({ kind: "assistant", text: "second", id: "late" });
	});

	it("separates thinking from assistant bubbles", () => {
		const s = reduce([
			{ type: "thinking_delta", sessionId: SID, text: "hmm " },
			{ type: "thinking_delta", sessionId: SID, text: "ok" },
			{ type: "assistant_text_delta", sessionId: SID, text: "Answer" },
		]);
		expect(s.items).toEqual([
			{ kind: "thinking", text: "hmm ok" },
			{ kind: "assistant", text: "Answer" },
		]);
	});

	it("a tool_use closes the open assistant bubble", () => {
		const s = reduce([
			{ type: "assistant_text_delta", sessionId: SID, text: "before" },
			{ type: "tool_use", sessionId: SID, toolUseId: "t1", name: "Read", input: { file_path: "/x" } },
			{ type: "assistant_text_delta", sessionId: SID, text: "after" },
		]);
		expect(s.items).toEqual([
			{ kind: "assistant", text: "before" },
			{ kind: "tool", entry: { toolUseId: "t1", name: "Read", input: { file_path: "/x" } } },
			{ kind: "assistant", text: "after" },
		]);
	});

	it("pairs a tool_result with its tool_use", () => {
		const s = reduce([
			{ type: "tool_use", sessionId: SID, toolUseId: "t1", name: "Read", input: {} },
			{ type: "tool_result", sessionId: SID, toolUseId: "t1", content: "file body", isError: false },
		]);
		expect(s.items).toEqual([
			{ kind: "tool", entry: { toolUseId: "t1", name: "Read", input: {}, result: { content: "file body", isError: false } } },
		]);
	});

	it("surfaces an orphan tool_result standalone", () => {
		const s = reduce([{ type: "tool_result", sessionId: SID, toolUseId: "zzz", content: "oops", isError: true }]);
		expect(s.items[0]).toMatchObject({ kind: "tool", entry: { name: "(result)", result: { isError: true } } });
	});

	it("tracks todos, status, model, writer, sessionId", () => {
		const s = reduce([
			{ type: "todo_update", sessionId: SID, todos: [{ content: "a", status: "pending" }] },
			{ type: "session_status", sessionId: SID, status: "working", model: "claude-x", cwd: "/v", isWriter: true },
		]);
		expect(s.todos).toHaveLength(1);
		expect(s).toMatchObject({ status: "working", model: "claude-x", isWriter: true, sessionId: SID });
	});

	it("records and clears a pending permission", () => {
		let s = applyEvent(initialState("m"), {
			type: "permission_request",
			sessionId: SID,
			toolUseId: "p1",
			name: "Bash",
			input: { command: "rm x" },
		});
		expect(s.pendingPermission?.toolUseId).toBe("p1");
		s = clearPermission(s, "p1");
		expect(s.pendingPermission).toBeUndefined();
		// clearing a different id is a no-op
		const s2 = clearPermission(applyEvent(initialState("m"), { type: "permission_request", sessionId: SID, toolUseId: "p1", name: "Bash", input: {} }), "other");
		expect(s2.pendingPermission?.toolUseId).toBe("p1");
	});

	it("a non-awaiting status clears a stale pending permission", () => {
		let s = applyEvent(initialState("m"), { type: "permission_request", sessionId: SID, toolUseId: "p1", name: "Bash", input: {} });
		s = applyEvent(s, { type: "session_status", sessionId: SID, status: "idle", model: "m", cwd: "/v", isWriter: true });
		expect(s.pendingPermission).toBeUndefined();
	});

	it("done closes the open bubble; error sets error text", () => {
		const s = reduce([
			{ type: "assistant_text_delta", sessionId: SID, text: "x" },
			{ type: "done", sessionId: SID, subtype: "success", isError: false },
			{ type: "assistant_text_delta", sessionId: SID, text: "y" },
		]);
		expect(s.items).toEqual([
			{ kind: "assistant", text: "x" },
			{ kind: "assistant", text: "y" },
		]);
		const e = applyEvent(initialState("m"), { type: "error", message: "bad" });
		expect(e.error).toBe("bad");
		// A toast (chat-view.ts) alone is missed on reattach — must persist as a
		// transcript item too, so it survives reload/replay (see reapStalledTurns).
		expect(e.items).toEqual([{ kind: "error", text: "bad" }]);
	});

	it("history_page prepends older messages (oldest above) and tracks hasMore", () => {
		let s = reduce([{ type: "assistant_text_delta", sessionId: SID, text: "current" }]);
		s = applyEvent(s, {
			type: "history_page",
			sessionId: SID,
			events: [
				{ type: "user_echo", sessionId: SID, text: "older q" },
				{ type: "assistant_text_delta", sessionId: SID, text: "older a" },
			],
			hasMore: true,
		});
		expect(s.items).toEqual([
			{ kind: "user", text: "older q" },
			{ kind: "assistant", text: "older a" },
			{ kind: "assistant", text: "current" },
		]);
		expect(s.hasOlderHistory).toBe(true);
	});

	it("session_status carries the permission mode", () => {
		const s = applyEvent(initialState("m"), {
			type: "session_status",
			sessionId: SID,
			status: "idle",
			model: "m",
			cwd: "/v",
			isWriter: true,
			permissionMode: "acceptEdits",
		});
		expect(s.permissionMode).toBe("acceptEdits");
	});

	it("attach_reset clears the transcript so the replay rebuilds it", () => {
		let s = reduce([
			{ type: "assistant_text_delta", sessionId: SID, text: "old" },
			{ type: "external_activity", sessionId: SID, severity: "busy", entrypoint: "cli" },
		]);
		expect(s.items.length).toBe(1);
		s = applyEvent(s, { type: "attach_reset", sessionId: SID });
		expect(s.items).toEqual([]);
		expect(s.externalActivity).toBe("none");
	});

	it("tracks external activity (read-only)", () => {
		const s = applyEvent(initialState("m"), {
			type: "external_activity",
			sessionId: SID,
			severity: "busy",
			entrypoint: "cli",
			pid: 3,
		});
		expect(s.externalActivity).toBe("busy");
		expect(s.externalEntrypoint).toBe("cli");
	});

	it("session_status carries hasOlderHistory", () => {
		const s = applyEvent(initialState("m"), {
			type: "session_status",
			sessionId: SID,
			status: "idle",
			model: "m",
			cwd: "/v",
			isWriter: true,
			hasOlderHistory: true,
		});
		expect(s.hasOlderHistory).toBe(true);
	});

	it("done records the session cost when present", () => {
		const s = applyEvent(initialState("m"), {
			type: "done",
			sessionId: SID,
			subtype: "success",
			isError: false,
			costUsd: 0.05,
		});
		expect(s.costUsd).toBe(0.05);
	});

	it("session_status carries context window usage on attach (before any turn runs)", () => {
		const s = applyEvent(initialState("m"), {
			type: "session_status",
			sessionId: SID,
			status: "idle",
			model: "m",
			cwd: "/v",
			isWriter: true,
			contextUsedPercent: 12,
		});
		expect(s.contextUsedPercent).toBe(12);
	});

	it("done records context window usage and keeps it across turns that omit it", () => {
		const s1 = applyEvent(initialState("m"), {
			type: "done",
			sessionId: SID,
			subtype: "success",
			isError: false,
			contextUsedPercent: 37,
		});
		expect(s1.contextUsedPercent).toBe(37);
		const s2 = applyEvent(s1, { type: "done", sessionId: SID, subtype: "success", isError: false });
		expect(s2.contextUsedPercent).toBe(37);
	});

	it("attach_reset clears context window usage", () => {
		const s = applyEvent(
			{ ...initialState("m"), contextUsedPercent: 80 },
			{ type: "attach_reset", sessionId: SID }
		);
		expect(s.contextUsedPercent).toBeUndefined();
	});

	it("sessions_list and setConnection / appendUserMessage helpers", () => {
		const s = applyEvent(initialState("m"), {
			type: "sessions_list",
			sessions: [{ sessionId: "a", model: "m", status: "idle", cwd: "/v" }],
		});
		expect(s.sessions).toHaveLength(1);
		expect(setConnection(s, "connecting").connection).toBe("connecting");
		expect(appendUserMessage(s, "hi").items.at(-1)).toEqual({ kind: "user", text: "hi" });
	});

	describe("groupActivity", () => {
		const thinking = (id: string): ChatItem => ({ kind: "thinking", text: "hmm", id });
		const tool = (toolUseId: string): ChatItem => ({ kind: "tool", entry: { toolUseId, name: "Read", input: {} } });
		const user = (text: string): ChatItem => ({ kind: "user", text });

		it("leaves user/assistant/error items untouched", () => {
			const items: ChatItem[] = [user("hi"), { kind: "assistant", text: "hey" }, { kind: "error", text: "oops" }];
			expect(groupActivity(items)).toEqual(items);
		});

		it("folds a run of consecutive tool/thinking items into one activity group", () => {
			const items = [user("go"), thinking("t1"), tool("u1"), tool("u2"), user("done")];
			const out = groupActivity(items);
			expect(out).toEqual([
				user("go"),
				{ kind: "activity", items: [thinking("t1"), tool("u1"), tool("u2")], key: "t1" },
				user("done"),
			]);
		});

		it("keys a tool-first group by its toolUseId", () => {
			const out = groupActivity([tool("u1"), thinking("t1")]);
			expect(out).toEqual([{ kind: "activity", items: [tool("u1"), thinking("t1")], key: "u1" }]);
		});

		it("splits separate runs into separate groups", () => {
			const out = groupActivity([tool("u1"), user("mid"), tool("u2")]);
			expect(out).toEqual([
				{ kind: "activity", items: [tool("u1")], key: "u1" },
				user("mid"),
				{ kind: "activity", items: [tool("u2")], key: "u2" },
			]);
		});
	});

	describe("summarizeActivity", () => {
		const thinking: ChatItem & { kind: "thinking" } = { kind: "thinking", text: "hmm" };
		const tool = (name: string): ChatItem & { kind: "tool" } => ({
			kind: "tool",
			entry: { toolUseId: "u", name, input: {} },
		});

		it("summarizes counts by kind when not live", () => {
			expect(summarizeActivity([thinking, tool("Read"), tool("Edit")], false)).toBe("1 thinking, 2 tools");
		});

		it("singularizes a single tool", () => {
			expect(summarizeActivity([tool("Read")], false)).toBe("1 tool");
		});

		it("shows the in-flight step and running count when live", () => {
			expect(summarizeActivity([tool("Read"), tool("Bash")], true)).toBe("Bash… (2 tools)");
			expect(summarizeActivity([tool("Read"), thinking], true)).toBe("Thinking… (1 thinking, 1 tool)");
		});
	});
});
