/**
 * Pure chat view-state reducer. Kept free of DOM and Obsidian APIs so the
 * stream-folding logic (delta accumulation, tool/result pairing, permission and
 * status tracking) is unit-tested in isolation; `chat-view.ts` just renders the
 * resulting state.
 */

import type {
	BridgeEvent,
	ExternalSeverity,
	PermissionMode,
	PermissionRequestEvent,
	RenderEvent,
	SessionStatus,
	SessionSummary,
	TodoItem,
} from "@occ/protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ToolEntry {
	toolUseId: string;
	name: string;
	input: unknown;
	result?: { content: string; isError: boolean };
}

export type ChatItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; entry: ToolEntry };

export interface ChatState {
	connection: ConnectionState;
	sessionId?: string;
	status: SessionStatus;
	isWriter: boolean;
	model: string;
	items: ChatItem[];
	/** which trailing item, if any, is still accreting deltas. */
	openKind: "assistant" | "thinking" | null;
	todos: TodoItem[];
	pendingPermission?: PermissionRequestEvent;
	sessions: SessionSummary[];
	/** true if older transcript exists beyond what's loaded (enables "load older"). */
	hasOlderHistory: boolean;
	/** cumulative session cost in USD, if known. */
	costUsd?: number;
	/** the session's agent permission mode. */
	permissionMode: PermissionMode;
	/** a live external (CLI) process holds the session → the plugin is read-only. */
	externalActivity: ExternalSeverity;
	/** the external holder's entrypoint, for the banner ("cli" | "sdk-cli" | …). */
	externalEntrypoint?: string;
	error?: string;
}

export function initialState(model: string): ChatState {
	return {
		connection: "disconnected",
		status: "idle",
		isWriter: false,
		model,
		items: [],
		openKind: null,
		todos: [],
		sessions: [],
		hasOlderHistory: false,
		permissionMode: "default",
		externalActivity: "none",
	};
}

export function setConnection(state: ChatState, connection: ConnectionState): ChatState {
	return { ...state, connection };
}

/** Append a locally-sent user turn (not echoed by the server). */
export function appendUserMessage(state: ChatState, text: string): ChatState {
	return { ...state, items: [...state.items, { kind: "user", text }], openKind: null };
}

function appendDelta(state: ChatState, kind: "assistant" | "thinking", text: string): ChatState {
	if (state.openKind === kind) {
		const items = state.items.slice();
		const last = items[items.length - 1];
		if (last && (last.kind === "assistant" || last.kind === "thinking")) {
			items[items.length - 1] = { kind, text: last.text + text };
			return { ...state, items };
		}
	}
	return { ...state, items: [...state.items, { kind, text }], openKind: kind };
}

export function applyEvent(state: ChatState, event: BridgeEvent): ChatState {
	switch (event.type) {
		case "ready":
			return { ...state, connection: "connected", error: undefined };
		case "assistant_text_delta":
			return appendDelta(state, "assistant", event.text);
		case "thinking_delta":
			return appendDelta(state, "thinking", event.text);
		case "user_echo":
			return { ...state, items: [...state.items, { kind: "user", text: event.text }], openKind: null };
		case "tool_use":
			return {
				...state,
				openKind: null,
				items: [
					...state.items,
					{ kind: "tool", entry: { toolUseId: event.toolUseId, name: event.name, input: event.input } },
				],
			};
		case "tool_result":
			return applyToolResult(state, event.toolUseId, event.content, event.isError);
		case "todo_update":
			return { ...state, todos: event.todos };
		case "permission_request":
			return { ...state, pendingPermission: event };
		case "done":
			return { ...state, openKind: null, costUsd: event.costUsd ?? state.costUsd };
		case "error":
			return { ...state, openKind: null, error: event.message };
		case "session_status":
			return {
				...state,
				sessionId: event.sessionId,
				status: event.status,
				model: event.model,
				isWriter: event.isWriter,
				hasOlderHistory: event.hasOlderHistory ?? state.hasOlderHistory,
				permissionMode: event.permissionMode ?? state.permissionMode,
				// a resolved/expired request is implied once we're no longer awaiting.
				pendingPermission: event.status === "awaiting_permission" ? state.pendingPermission : undefined,
			};
		case "attach_reset":
			// Clear the transcript so the replay that follows rebuilds cleanly.
			return {
				...state,
				items: [],
				openKind: null,
				todos: [],
				pendingPermission: undefined,
				hasOlderHistory: false,
				costUsd: undefined,
				externalActivity: "none",
				externalEntrypoint: undefined,
			};
		case "external_activity":
			return { ...state, externalActivity: event.severity, externalEntrypoint: event.entrypoint };
		case "history_page":
			return prependHistory(state, event.events, event.hasMore);
		case "sessions_list":
			return { ...state, sessions: event.sessions };
		default:
			return state;
	}
}

function applyToolResult(state: ChatState, toolUseId: string, content: string, isError: boolean): ChatState {
	const items = state.items.slice();
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item && item.kind === "tool" && item.entry.toolUseId === toolUseId && !item.entry.result) {
			items[i] = { kind: "tool", entry: { ...item.entry, result: { content, isError } } };
			return { ...state, items, openKind: null };
		}
	}
	// orphan result (tool_use not seen) — surface it standalone.
	return {
		...state,
		openKind: null,
		items: [...items, { kind: "tool", entry: { toolUseId, name: "(result)", input: undefined, result: { content, isError } } }],
	};
}

/** Fold an older render-event batch into items and prepend them (oldest above). */
export function prependHistory(state: ChatState, events: RenderEvent[], hasMore: boolean): ChatState {
	const folded = events.reduce(applyEvent, initialState(state.model)).items;
	return { ...state, items: [...folded, ...state.items], hasOlderHistory: hasMore };
}

/** Resolve a pending permission (after the client sends its decision). */
export function clearPermission(state: ChatState, toolUseId: string): ChatState {
	if (state.pendingPermission?.toolUseId !== toolUseId) return state;
	return { ...state, pendingPermission: undefined };
}
