import { extractTodos, mapHistoryMessages, mapSdkEvent, stringifyToolResult, type HistoryMessage } from "../src/map-sdk-events";
import type { SdkMessage } from "../src/sdk-types";

const SID = "sess-1";

describe("mapSdkEvent", () => {
	it("maps text deltas to assistant_text_delta", () => {
		const msg: SdkMessage = {
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
		};
		expect(mapSdkEvent(msg, SID)).toEqual([{ type: "assistant_text_delta", sessionId: SID, text: "Hello" }]);
	});

	it("maps thinking deltas to thinking_delta", () => {
		const msg: SdkMessage = {
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
		};
		expect(mapSdkEvent(msg, SID)).toEqual([{ type: "thinking_delta", sessionId: SID, text: "hmm" }]);
	});

	it("ignores empty deltas and non-delta stream events", () => {
		expect(
			mapSdkEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } } }, SID)
		).toEqual([]);
		expect(mapSdkEvent({ type: "stream_event", event: { type: "content_block_start" } }, SID)).toEqual([]);
		expect(mapSdkEvent({ type: "stream_event" } as SdkMessage, SID)).toEqual([]);
	});

	it("emits tool_use blocks from assistant messages but not text (already streamed)", () => {
		const msg: SdkMessage = {
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "ignored, already streamed" },
					{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } },
				],
			},
		};
		expect(mapSdkEvent(msg, SID)).toEqual([
			{ type: "tool_use", sessionId: SID, toolUseId: "tu1", name: "Read", input: { file_path: "/x" } },
		]);
	});

	it("maps TodoWrite tool_use to todo_update", () => {
		const msg: SdkMessage = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "tu2",
						name: "TodoWrite",
						input: {
							todos: [
								{ content: "a", status: "completed", activeForm: "doing a" },
								{ content: "b", status: "in_progress" },
								{ content: "c", status: "pending" },
							],
						},
					},
				],
			},
		};
		expect(mapSdkEvent(msg, SID)).toEqual([
			{
				type: "todo_update",
				sessionId: SID,
				todos: [
					{ content: "a", status: "completed", activeForm: "doing a" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "pending" },
				],
			},
		]);
	});

	it("maps tool_result blocks from user messages", () => {
		const msg: SdkMessage = {
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents", is_error: false }],
			},
		};
		expect(mapSdkEvent(msg, SID)).toEqual([
			{ type: "tool_result", sessionId: SID, toolUseId: "tu1", content: "file contents", isError: false },
		]);
	});

	it("maps result to done and reads is_error", () => {
		expect(mapSdkEvent({ type: "result", subtype: "success", is_error: false }, SID)).toEqual([
			{ type: "done", sessionId: SID, subtype: "success", isError: false },
		]);
		expect(mapSdkEvent({ type: "result", subtype: "error_max_turns", is_error: true }, SID)).toEqual([
			{ type: "done", sessionId: SID, subtype: "error_max_turns", isError: true },
		]);
		expect(mapSdkEvent({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.042 }, SID)).toEqual([
			{ type: "done", sessionId: SID, subtype: "success", isError: false, costUsd: 0.042 },
		]);
	});

	it("prefers the session id carried on the message", () => {
		const msg: SdkMessage = { type: "result", subtype: "success", session_id: "real-id" };
		expect(mapSdkEvent(msg, SID)[0]).toMatchObject({ sessionId: "real-id" });
	});

	it("returns [] for system/init and unknown types", () => {
		expect(mapSdkEvent({ type: "system", subtype: "init", session_id: "x" }, SID)).toEqual([]);
		expect(mapSdkEvent({ type: "something_new" } as SdkMessage, SID)).toEqual([]);
	});
});

describe("stringifyToolResult", () => {
	it("passes strings through", () => {
		expect(stringifyToolResult("hi")).toBe("hi");
	});
	it("joins text blocks", () => {
		expect(stringifyToolResult([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
		expect(stringifyToolResult(["x", { type: "text", text: "y" }, { type: "image" }])).toBe("xy");
	});
	it("handles null and objects", () => {
		expect(stringifyToolResult(null)).toBe("");
		expect(stringifyToolResult(undefined)).toBe("");
		expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
	});
});

describe("mapHistoryMessages", () => {
	it("emits user echoes, assistant text (incl. text, unlike live), tool use and results", () => {
		const msgs: HistoryMessage[] = [
			{ type: "user", message: { content: "hello" } },
			{
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "hi!" },
						{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
					],
				},
			},
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "data", is_error: false }] } },
			{ type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
			{ type: "system", message: {} },
		];
		expect(mapHistoryMessages(msgs, "s")).toEqual([
			{ type: "user_echo", sessionId: "s", text: "hello" },
			{ type: "assistant_text_delta", sessionId: "s", text: "hi!" },
			{ type: "tool_use", sessionId: "s", toolUseId: "t1", name: "Read", input: { file_path: "/x" } },
			{ type: "tool_result", sessionId: "s", toolUseId: "t1", content: "data", isError: false },
			{ type: "assistant_text_delta", sessionId: "s", text: "done" },
		]);
	});

	it("skips blank user turns and reads array text content", () => {
		expect(mapHistoryMessages([{ type: "user", message: { content: "   " } }], "s")).toEqual([]);
		expect(mapHistoryMessages([{ type: "user", message: { content: [{ type: "text", text: "x" }] } }], "s")).toEqual([
			{ type: "user_echo", sessionId: "s", text: "x" },
		]);
	});

	it("threads the message uuid inline as the deep-link anchor (history)", () => {
		const msgs: HistoryMessage[] = [
			{ type: "user", message: { content: "hello" }, uuid: "u-1" },
			{ type: "assistant", message: { content: [{ type: "text", text: "hi!" }] }, uuid: "a-1" },
		];
		expect(mapHistoryMessages(msgs, "s")).toEqual([
			{ type: "user_echo", sessionId: "s", text: "hello", messageId: "u-1" },
			{ type: "assistant_text_delta", sessionId: "s", text: "hi!", messageId: "a-1" },
		]);
	});
});

describe("message anchors (live)", () => {
	it("emits a message_anchor for a streamed assistant text message, carrying its uuid", () => {
		const msg: SdkMessage = { type: "assistant", uuid: "a-uuid", message: { content: [{ type: "text", text: "streamed" }] } } as SdkMessage;
		expect(mapSdkEvent(msg, SID)).toEqual([{ type: "message_anchor", sessionId: SID, messageId: "a-uuid", kind: "assistant" }]);
	});

	it("emits a thinking anchor for a streamed thinking message", () => {
		const msg: SdkMessage = { type: "assistant", uuid: "t-uuid", message: { content: [{ type: "thinking", thinking: "…" }] } } as SdkMessage;
		expect(mapSdkEvent(msg, SID)).toEqual([{ type: "message_anchor", sessionId: SID, messageId: "t-uuid", kind: "thinking" }]);
	});

	it("still emits tool_use alongside the anchor, and no anchor without a uuid", () => {
		const withTool: SdkMessage = {
			type: "assistant",
			uuid: "a-2",
			message: { content: [{ type: "text", text: "x" }, { type: "tool_use", id: "tt", name: "Read", input: {} }] },
		} as SdkMessage;
		expect(mapSdkEvent(withTool, SID)).toEqual([
			{ type: "tool_use", sessionId: SID, toolUseId: "tt", name: "Read", input: {} },
			{ type: "message_anchor", sessionId: SID, messageId: "a-2", kind: "assistant" },
		]);
		// No uuid → no anchor (unchanged behaviour).
		const noUuid: SdkMessage = { type: "assistant", message: { content: [{ type: "text", text: "x" }] } };
		expect(mapSdkEvent(noUuid, SID)).toEqual([]);
	});
});

describe("extractTodos", () => {
	it("returns [] for malformed input", () => {
		expect(extractTodos(undefined)).toEqual([]);
		expect(extractTodos({})).toEqual([]);
		expect(extractTodos({ todos: "nope" })).toEqual([]);
	});
	it("normalises status and skips junk entries", () => {
		expect(extractTodos({ todos: [{ content: "x", status: "weird" }, null, { content: "y", status: "completed" }] })).toEqual([
			{ content: "x", status: "pending" },
			{ content: "y", status: "completed" },
		]);
	});
});
