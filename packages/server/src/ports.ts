/**
 * Ports (interfaces) for the side-effecting dependencies, so the session core
 * can be unit-tested with fakes. The real implementations live in
 * `sdk-adapter.ts` (the `query()` shell) and `ws-transport.ts` (the socket).
 */

import type { SdkMessage } from "@occ/protocol";

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

/** The object returned by `query()`: an async iterable of SDK messages + interrupt. */
export interface QueryHandle extends AsyncIterable<SdkMessage> {
	interrupt(): Promise<void>;
}

/** Injected SDK entrypoint. Real = `sdk-adapter.runQuery`; test = a scripted generator. */
export type RunQuery = (prompt: AsyncIterable<UserInputMessage>, options: QueryOptions) => QueryHandle;

/** Injected clock, so tests are deterministic. */
export type Clock = () => number;
