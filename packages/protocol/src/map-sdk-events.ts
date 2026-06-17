/**
 * Pure mapping from SDK stream messages to client-facing bridge render events.
 *
 * Design notes:
 * - With `includePartialMessages: true`, assistant text/thinking arrive as
 *   `stream_event` deltas and are streamed incrementally. We therefore do NOT
 *   re-emit text from the (later) full `assistant` message — only its tool_use
 *   blocks — to avoid double-rendering.
 * - A `TodoWrite` tool_use is surfaced as a `todo_update` instead of a generic
 *   `tool_use` block.
 * - Anything unrecognised maps to `[]` (no-op), so the mapper is total.
 */

import type { RenderEvent, TodoItem } from "./messages";
import type {
	SdkContentBlock,
	SdkMessage,
	SdkStreamEventMessage,
	SdkToolResultBlock,
	SdkToolUseBlock,
} from "./sdk-types";
import { sdkSessionId } from "./sdk-types";

const TODO_TOOL = "TodoWrite";

/** Map one SDK message to zero or more render events. `sessionId` is the actor's known id. */
export function mapSdkEvent(msg: SdkMessage, sessionId: string): RenderEvent[] {
	const sid = sdkSessionId(msg) ?? sessionId;
	switch (msg.type) {
		case "stream_event":
			return mapStreamEvent(msg as SdkStreamEventMessage, sid);
		case "assistant":
			return mapAssistant((msg as { message?: { content?: unknown } }).message, sid);
		case "user":
			return mapUserResult((msg as { message?: { content?: unknown } }).message, sid);
		case "result":
			return [
				{
					type: "done",
					sessionId: sid,
					subtype: String((msg as { subtype?: unknown }).subtype ?? "success"),
					isError: Boolean((msg as { is_error?: unknown }).is_error),
				},
			];
		default:
			// system/init and any unknown message types carry no render payload.
			return [];
	}
}

function mapStreamEvent(msg: SdkStreamEventMessage, sessionId: string): RenderEvent[] {
	const ev = msg.event;
	if (!ev || ev.type !== "content_block_delta" || !ev.delta) return [];
	const delta = ev.delta;
	if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
		return [{ type: "assistant_text_delta", sessionId, text: delta.text }];
	}
	if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
		return [{ type: "thinking_delta", sessionId, text: delta.thinking }];
	}
	return [];
}

function asBlocks(content: unknown): SdkContentBlock[] {
	return Array.isArray(content) ? (content as SdkContentBlock[]) : [];
}

function mapAssistant(message: { content?: unknown } | undefined, sessionId: string): RenderEvent[] {
	const out: RenderEvent[] = [];
	for (const block of asBlocks(message?.content)) {
		if (block.type !== "tool_use") continue;
		const tu = block as SdkToolUseBlock;
		if (tu.name === TODO_TOOL) {
			out.push({ type: "todo_update", sessionId, todos: extractTodos(tu.input) });
		} else {
			out.push({ type: "tool_use", sessionId, toolUseId: tu.id, name: tu.name, input: tu.input });
		}
	}
	return out;
}

function mapUserResult(message: { content?: unknown } | undefined, sessionId: string): RenderEvent[] {
	const out: RenderEvent[] = [];
	for (const block of asBlocks(message?.content)) {
		if (block.type !== "tool_result") continue;
		const tr = block as SdkToolResultBlock;
		out.push({
			type: "tool_result",
			sessionId,
			toolUseId: tr.tool_use_id,
			content: stringifyToolResult(tr.content),
			isError: Boolean(tr.is_error),
		});
	}
	return out;
}

/** Tool-result content can be a string or an array of `{type:"text",text}` blocks. */
export function stringifyToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
					return (part as { text: string }).text;
				}
				return "";
			})
			.join("");
	}
	if (content == null) return "";
	return JSON.stringify(content);
}

/** Coerce a TodoWrite tool input into a clean TodoItem[]. */
export function extractTodos(input: unknown): TodoItem[] {
	const raw = (input as { todos?: unknown })?.todos;
	if (!Array.isArray(raw)) return [];
	const out: TodoItem[] = [];
	for (const t of raw) {
		if (!t || typeof t !== "object") continue;
		const rec = t as Record<string, unknown>;
		const content = typeof rec.content === "string" ? rec.content : "";
		const status = rec.status === "in_progress" || rec.status === "completed" ? rec.status : "pending";
		const item: TodoItem = { content, status };
		if (typeof rec.activeForm === "string") item.activeForm = rec.activeForm;
		out.push(item);
	}
	return out;
}
