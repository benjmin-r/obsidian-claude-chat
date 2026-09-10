/**
 * Ports (interfaces) for the side-effecting dependencies, so the session core
 * can be unit-tested with fakes. The real implementations live in
 * `sdk-adapter.ts` (the `query()` shell) and `ws-transport.ts` (the socket).
 */

import type { ExternalActivity } from "./external-activity";
import type { HistoryMessage, PermissionMode, SdkMessage } from "@occ/protocol";

export interface PermissionAllow {
	behavior: "allow";
	updatedInput: Record<string, unknown>;
}

export interface PermissionDeny {
	behavior: "deny";
	message: string;
}

export type PermissionResult = PermissionAllow | PermissionDeny;

/** Matches the SDK's `canUseTool` callback shape (the bits we use). */
export type CanUseTool = (
	toolName: string,
	input: Record<string, unknown>,
	opts: { toolUseID?: string; signal?: AbortSignal }
) => Promise<PermissionResult>;

export interface QueryOptions {
	cwd: string;
	model: string;
	permissionMode: PermissionMode;
	/** present only when reconstructing a session after a server restart. */
	resume?: string;
	canUseTool: CanUseTool;
}

/** A single user turn pushed into the streaming-input generator. */
export interface UserInputMessage {
	type: "user";
	message: { role: "user"; content: string };
	parent_tool_use_id?: null;
	session_id?: string;
}

/** Context window usage as of the last completed turn (from the SDK's `getContextUsage`). */
export interface ContextUsage {
	/** share of the context window used, 0-100. */
	percentage: number;
	totalTokens: number;
	maxTokens: number;
}

/** The object returned by `query()`: an async iterable of SDK messages + controls. */
export interface QueryHandle extends AsyncIterable<SdkMessage> {
	/** Cancel the in-flight TURN only; the session (and its subprocess) stays alive. */
	interrupt(): Promise<void>;
	setPermissionMode(mode: PermissionMode): Promise<void>;
	/**
	 * Terminate the session for good: close the async generator so the SDK tears
	 * down the CLI subprocess. Unlike {@link interrupt}, this frees the OS process —
	 * without it, dropped/reaped sessions orphan a resident subprocess.
	 */
	dispose(): Promise<void>;
	/**
	 * Best-effort breakdown of current context window usage (mirrors the CLI's
	 * `/context`). Optional so test fakes needn't implement it; real callers should
	 * treat a thrown/rejected call as "unknown" rather than fatal.
	 */
	getContextUsage?(): Promise<ContextUsage | null>;
}

/** Injected SDK entrypoint. Real = `sdk-adapter.runQuery`; test = a scripted generator. */
export type RunQuery = (prompt: AsyncIterable<UserInputMessage>, options: QueryOptions) => QueryHandle;

/** Injected clock, so tests are deterministic. */
export type Clock = () => number;

/** Summary of a persisted session from the CLI store. */
export interface StoredSessionInfo {
	sessionId: string;
	title: string;
	updatedAt: number;
	/** epoch ms of the first entry in the session's transcript, if known. */
	createdAt?: number;
	archived: boolean;
}

/** Enumerate persisted sessions for a project dir (real = SDK `listSessions`). */
export type ListStored = (cwd: string) => Promise<StoredSessionInfo[]>;

/** Load a persisted session's messages (real = SDK `getSessionMessages`). */
export type LoadHistory = (cwd: string, sessionId: string) => Promise<HistoryMessage[]>;

/** Set a persisted session's title (real = SDK `renameSession`). */
export type RenameStored = (cwd: string, sessionId: string, title: string) => Promise<void>;

/** Permanently delete a persisted session (real = SDK `deleteSession`). */
export type DeleteStored = (cwd: string, sessionId: string) => Promise<void>;

/** Set a persisted session's archived flag (real = SDK `tagSession`). */
export type ArchiveStored = (cwd: string, sessionId: string, archived: boolean) => Promise<void>;

/**
 * Detect whether a session is held by a live process other than this server, in
 * the given working dir (real = reads `~/.claude/sessions/*.json`). Best-effort:
 * returns `{ severity: "none" }` if the registry is missing/unreadable.
 */
export type DetectExternalActivity = (cwd: string, sessionId: string) => ExternalActivity;
