/**
 * Wire protocol for the JSON-over-WebSocket bridge between the SDK server and
 * the Obsidian plugin. This module is the SINGLE SOURCE OF TRUTH for the
 * protocol — both `@occ/server` and `@occ/plugin` import these types, which is
 * what prevents the message-shape drift that bit the stock relay plugin.
 *
 * Pure types + constants only; no runtime I/O.
 */

/** Bumped whenever the wire shapes change incompatibly. Validated on `hello`. */
export const PROTOCOL_VERSION = 1;

/** Lifecycle state of a server-owned session actor. */
export type SessionStatus = "idle" | "working" | "awaiting_permission";

/**
 * Agent permission modes we expose. These are runtime-switchable via
 * setPermissionMode (verified). 'auto' uses a model classifier to approve/deny,
 * escalating to a prompt only when unsure. Excluded: 'bypassPermissions' (needs
 * the session launched with --dangerously-skip-permissions) and 'plan' (needs
 * exit-plan handling we don't have yet).
 */
export type PermissionMode = "default" | "acceptEdits" | "auto";

/**
 * Whether a session is held by a live process OTHER than this server, in the
 * same working dir: 'busy' = mid-turn, 'idle' = open but parked, 'none' = free.
 */
export type ExternalSeverity = "none" | "idle" | "busy";

/** A single TodoWrite item, as surfaced to the plugin's todo list. */
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
}

/** Summary of a session for the plugin's session list / reattach UI. */
export interface SessionSummary {
	sessionId: string;
	title?: string;
	model: string;
	status: SessionStatus;
	cwd: string;
	/** epoch ms of last activity, if known. */
	updatedAt?: number;
	messageCount?: number;
	/** true when another client currently holds the writer role. */
	hasWriter?: boolean;
}

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

/** Sent once after a successful `hello` handshake. */
export interface ReadyEvent {
	type: "ready";
	protocolVersion: number;
}

/** Incremental assistant text (streamed token deltas, never buffered). */
export interface AssistantTextDeltaEvent {
	type: "assistant_text_delta";
	sessionId: string;
	text: string;
}

/** Incremental extended-thinking text. */
export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	sessionId: string;
	text: string;
}

/** A historical user turn, replayed when resuming a past session. */
export interface UserEchoEvent {
	type: "user_echo";
	sessionId: string;
	text: string;
}

/** A tool the agent invoked (non-TodoWrite). */
export interface ToolUseEvent {
	type: "tool_use";
	sessionId: string;
	toolUseId: string;
	name: string;
	input: unknown;
}

/** The result of a previously-emitted tool use. */
export interface ToolResultEvent {
	type: "tool_result";
	sessionId: string;
	toolUseId: string;
	content: string;
	isError: boolean;
}

/** The current TodoWrite list. */
export interface TodoUpdateEvent {
	type: "todo_update";
	sessionId: string;
	todos: TodoItem[];
}

/** A destructive tool is awaiting an allow/deny decision from the client. */
export interface PermissionRequestEvent {
	type: "permission_request";
	sessionId: string;
	toolUseId: string;
	name: string;
	input: unknown;
}

/** A turn finished (maps from the SDK `result` message). */
export interface DoneEvent {
	type: "done";
	sessionId: string;
	subtype: string;
	isError: boolean;
	/** cumulative session cost in USD, if the SDK reported it. */
	costUsd?: number;
}

/** An error surfaced to the client. */
export interface ErrorEvent {
	type: "error";
	sessionId?: string;
	message: string;
}

/** The list of known sessions (reply to `list_sessions`). */
export interface SessionsListEvent {
	type: "sessions_list";
	sessions: SessionSummary[];
}

/** A session's current status (sent on attach and on every transition). */
export interface SessionStatusEvent {
	type: "session_status";
	sessionId: string;
	status: SessionStatus;
	model: string;
	cwd: string;
	/** true if THIS client holds the single-writer role. */
	isWriter: boolean;
	/** true if older history exists beyond what was sent on attach. */
	hasOlderHistory?: boolean;
	/** the session's current agent permission mode. */
	permissionMode?: PermissionMode;
}

/** A session is held by a live process other than this server (corruption guard). */
export interface ExternalActivityEvent {
	type: "external_activity";
	sessionId: string;
	severity: ExternalSeverity;
	/** the foreign holder's entrypoint ("cli" | "sdk-cli" | …) and pid, for display. */
	entrypoint?: string;
	pid?: number;
}

/** The on-disk transcript has advanced past what this server's actor holds. */
export interface SessionStaleEvent {
	type: "session_stale";
	sessionId: string;
	stale: boolean;
}

/** A batch of older transcript events to PREPEND (reply to `load_older`). */
export interface HistoryPageEvent {
	type: "history_page";
	sessionId: string;
	/** older render events, oldest-first; prepend above the current transcript. */
	events: RenderEvent[];
	/** true if still-older history remains. */
	hasMore: boolean;
}

/** Discriminated union of every server -> client frame. */
export type BridgeEvent =
	| ReadyEvent
	| AssistantTextDeltaEvent
	| ThinkingDeltaEvent
	| UserEchoEvent
	| ToolUseEvent
	| ToolResultEvent
	| TodoUpdateEvent
	| PermissionRequestEvent
	| DoneEvent
	| ErrorEvent
	| SessionsListEvent
	| SessionStatusEvent
	| ExternalActivityEvent
	| SessionStaleEvent
	| HistoryPageEvent;

/** The subset of BridgeEvents that are derived purely from SDK stream messages. */
export type RenderEvent =
	| AssistantTextDeltaEvent
	| ThinkingDeltaEvent
	| UserEchoEvent
	| ToolUseEvent
	| ToolResultEvent
	| TodoUpdateEvent
	| DoneEvent
	| ErrorEvent;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

/** Handshake: bearer token + optional immediate attach to an existing session. */
export interface HelloMessage {
	type: "hello";
	token: string;
	attach?: string;
	protocolVersion?: number;
}

/** User prompt pushed into a session's input queue. */
export interface UserMessageMessage {
	type: "user_message";
	sessionId: string;
	text: string;
}

/** Resolution of a pending `permission_request`. */
export interface PermissionDecisionMessage {
	type: "permission_decision";
	sessionId: string;
	toolUseId: string;
	allow: boolean;
	/** optional human-readable reason when denying. */
	message?: string;
}

/** Cancel the in-flight turn. */
export interface InterruptMessage {
	type: "interrupt";
	sessionId: string;
}

/** Start a brand-new session. */
export interface NewSessionMessage {
	type: "new_session";
	model?: string;
}

/** Reattach / resume an existing session by id. */
export interface ResumeSessionMessage {
	type: "resume_session";
	sessionId: string;
}

/** Set a session's display title. */
export interface RenameSessionMessage {
	type: "rename_session";
	sessionId: string;
	title: string;
}

/** Permanently delete a session. */
export interface DeleteSessionMessage {
	type: "delete_session";
	sessionId: string;
}

/** Change the agent permission mode for a session. */
export interface SetPermissionModeMessage {
	type: "set_permission_mode";
	sessionId: string;
	mode: PermissionMode;
}

/** Request the next older page of a resumed session's transcript. */
export interface LoadOlderMessage {
	type: "load_older";
	sessionId: string;
}

/** Request the current session list. */
export interface ListSessionsMessage {
	type: "list_sessions";
}

/** Discriminated union of every client -> server frame. */
export type ClientMessage =
	| HelloMessage
	| UserMessageMessage
	| PermissionDecisionMessage
	| InterruptMessage
	| NewSessionMessage
	| ResumeSessionMessage
	| RenameSessionMessage
	| DeleteSessionMessage
	| SetPermissionModeMessage
	| LoadOlderMessage
	| ListSessionsMessage;
