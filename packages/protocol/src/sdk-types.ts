/**
 * Minimal STRUCTURAL shapes of the `@anthropic-ai/claude-agent-sdk` stream
 * messages that the pure mapper consumes. We deliberately do NOT depend on the
 * SDK package here so that `@occ/protocol` stays dependency-free and trivially
 * unit-testable. Real SDK messages structurally satisfy these interfaces; the
 * mapper treats anything it doesn't recognise as a no-op.
 */

export interface SdkTextBlock {
	type: "text";
	text: string;
}

export interface SdkThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface SdkToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

export interface SdkToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: unknown;
	is_error?: boolean;
}

export type SdkContentBlock =
	| SdkTextBlock
	| SdkThinkingBlock
	| SdkToolUseBlock
	| SdkToolResultBlock
	| { type: string; [k: string]: unknown };

export interface SdkSystemMessage {
	type: "system";
	subtype?: string;
	session_id?: string;
}

export interface SdkAssistantMessage {
	type: "assistant";
	session_id?: string;
	message: { content: SdkContentBlock[] };
}

export interface SdkUserResultMessage {
	type: "user";
	session_id?: string;
	message: { content: SdkContentBlock[] | string };
}

export interface SdkResultMessage {
	type: "result";
	subtype: string;
	session_id?: string;
	is_error?: boolean;
	result?: string;
	total_cost_usd?: number;
}

/** Emitted when `includePartialMessages: true`; wraps a raw Anthropic stream event. */
export interface SdkStreamEventMessage {
	type: "stream_event";
	session_id?: string;
	event: {
		type: string;
		index?: number;
		delta?: {
			type?: string;
			text?: string;
			thinking?: string;
			partial_json?: string;
		};
		content_block?: { type?: string; [k: string]: unknown };
	};
}

export type SdkMessage =
	| SdkSystemMessage
	| SdkAssistantMessage
	| SdkUserResultMessage
	| SdkResultMessage
	| SdkStreamEventMessage
	| { type: string; [k: string]: unknown };

/** Pull the session id off any SDK message that carries one. */
export function sdkSessionId(msg: SdkMessage): string | undefined {
	const id = (msg as { session_id?: unknown }).session_id;
	return typeof id === "string" ? id : undefined;
}
