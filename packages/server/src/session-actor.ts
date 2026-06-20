/**
 * SessionActor — owns ONE long-lived `query()` session.
 *
 * Load-bearing principle (see PLAN): the server owns the session; the plugin is
 * a detachable view. The actor:
 *  - drives the query via an async-generator input queue (one item per turn);
 *  - keeps a ring buffer of transcript events for replay-on-attach (Level-2);
 *  - resolves `canUseTool` against the pure destructive predicate, routing
 *    destructive tools to the client and auto-allowing edits/reads;
 *  - tracks status (idle | working | awaiting_permission).
 *
 * All side effects are injected (`runQuery`, `now`), so the whole class is
 * unit-testable with no real SDK and no socket.
 */

import {
	type BridgeEvent,
	type PermissionRequestEvent,
	type RenderEvent,
	type SessionStatus,
	type SessionStatusEvent,
	type SessionSummary,
	isDestructive,
	mapSdkEvent,
	sdkSessionId,
} from "@occ/protocol";
import { AsyncInputQueue } from "./async-queue";
import type {
	CanUseTool,
	Clock,
	PermissionResult,
	QueryHandle,
	RunQuery,
	UserInputMessage,
} from "./ports";

export interface SessionActorDeps {
	runQuery: RunQuery;
	now: Clock;
}

export interface SessionActorOptions {
	/** stable in-memory handle; the real SDK id replaces it once known. */
	handleId: string;
	cwd: string;
	model: string;
	/** set only when reconstructing after a restart. */
	resume?: string;
	/** max transcript events retained for replay-on-attach. */
	bufferLimit?: number;
}

type Listener = (event: BridgeEvent) => void;

const DEFAULT_BUFFER_LIMIT = 2000;

export class SessionActor {
	private readonly input = new AsyncInputQueue<UserInputMessage>();
	private readonly listeners = new Set<Listener>();
	private readonly buffer: RenderEvent[] = [];
	private readonly pendingPermissions = new Map<string, (r: PermissionResult) => void>();
	private readonly bufferLimit: number;

	private handle: QueryHandle | undefined;
	private started = false;
	private _status: SessionStatus = "idle";
	private _sdkSessionId: string | undefined;
	private _updatedAt: number;
	private _messageCount = 0;
	private pendingRequest: PermissionRequestEvent | undefined;
	private permissionCounter = 0;

	constructor(
		private readonly deps: SessionActorDeps,
		private readonly opts: SessionActorOptions
	) {
		this.bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
		this._sdkSessionId = opts.resume;
		this._updatedAt = deps.now();
	}

	/** The id clients should use: the real SDK id once known, else the handle. */
	get id(): string {
		return this._sdkSessionId ?? this.opts.handleId;
	}

	get handleId(): string {
		return this.opts.handleId;
	}

	get sdkSessionId(): string | undefined {
		return this._sdkSessionId;
	}

	get status(): SessionStatus {
		return this._status;
	}

	get model(): string {
		return this.opts.model;
	}

	get cwd(): string {
		return this.opts.cwd;
	}

	/** Begin consuming the query. Idempotent. */
	ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.handle = this.deps.runQuery(this.input, {
			cwd: this.opts.cwd,
			model: this.opts.model,
			resume: this.opts.resume,
			canUseTool: this.canUseTool,
		});
		void this.consume(this.handle);
	}

	/** Push a user turn into the session. */
	enqueue(text: string): void {
		this.ensureStarted();
		this._messageCount += 1;
		this._updatedAt = this.deps.now();
		this.input.push({ type: "user", message: { role: "user", content: text } });
		this.setStatus("working");
	}

	/** Cancel the in-flight turn. */
	async interrupt(): Promise<void> {
		await this.handle?.interrupt();
	}

	/** Resolve a pending destructive-tool permission request. */
	decidePermission(toolUseId: string, allow: boolean, message?: string): void {
		const resolve = this.pendingPermissions.get(toolUseId);
		if (!resolve) return;
		this.pendingPermissions.delete(toolUseId);
		if (this.pendingRequest?.toolUseId === toolUseId) this.pendingRequest = undefined;
		if (allow) {
			resolve({ behavior: "allow", updatedInput: this.lastInputs.get(toolUseId) ?? {} });
		} else {
			resolve({ behavior: "deny", message: message ?? "Denied by user" });
		}
		this.setStatus(this.pendingPermissions.size > 0 ? "awaiting_permission" : "working");
	}

	/**
	 * Attach a client. Replays the buffered transcript, then the live tail.
	 * Sends a fresh status and re-surfaces any still-pending permission request.
	 * @returns an unsubscribe function.
	 */
	subscribe(listener: Listener): () => void {
		for (const event of this.buffer) listener(event);
		listener(this.statusEvent());
		if (this.pendingRequest) listener(this.pendingRequest);
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Pre-fill the replay buffer with a resumed session's prior transcript, so
	 * the first client to attach repaints the history. Call before any attach.
	 */
	seedHistory(events: RenderEvent[]): void {
		for (const event of events) {
			this.buffer.push(event);
			if (this.buffer.length > this.bufferLimit) this.buffer.shift();
		}
	}

	statusEvent(): SessionStatusEvent {
		return {
			type: "session_status",
			sessionId: this.id,
			status: this._status,
			model: this.opts.model,
			cwd: this.opts.cwd,
			isWriter: false, // the transport rewrites this per-connection.
		};
	}

	summary(): SessionSummary {
		return {
			sessionId: this.id,
			model: this.opts.model,
			status: this._status,
			cwd: this.opts.cwd,
			updatedAt: this._updatedAt,
			messageCount: this._messageCount,
		};
	}

	// -- internals -----------------------------------------------------------

	private readonly lastInputs = new Map<string, Record<string, unknown>>();

	private readonly canUseTool: CanUseTool = (toolName, input, opts) => {
		if (!isDestructive(toolName, input)) {
			return Promise.resolve<PermissionResult>({ behavior: "allow", updatedInput: input });
		}
		const toolUseId = opts.toolUseID ?? `perm-${(this.permissionCounter += 1)}`;
		this.lastInputs.set(toolUseId, input);
		return new Promise<PermissionResult>((resolve) => {
			this.pendingPermissions.set(toolUseId, resolve);
			this.pendingRequest = {
				type: "permission_request",
				sessionId: this.id,
				toolUseId,
				name: toolName,
				input,
			};
			this.setStatus("awaiting_permission");
			this.broadcast(this.pendingRequest);
		});
	};

	private async consume(handle: QueryHandle): Promise<void> {
		try {
			for await (const msg of handle) {
				const carried = sdkSessionId(msg);
				if (carried && carried !== this._sdkSessionId) {
					this._sdkSessionId = carried;
					this.broadcast(this.statusEvent()); // tell clients the canonical id
				}
				for (const event of mapSdkEvent(msg, this.id)) {
					this.record(event);
				}
				if (msg.type === "result") {
					this.setStatus("idle");
				}
			}
			this.setStatus("idle");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.record({ type: "error", sessionId: this.id, message });
			this.setStatus("idle");
		}
	}

	private setStatus(status: SessionStatus): void {
		if (status === this._status) return;
		this._status = status;
		this._updatedAt = this.deps.now();
		this.broadcast(this.statusEvent());
	}

	private record(event: RenderEvent): void {
		this.buffer.push(event);
		if (this.buffer.length > this.bufferLimit) this.buffer.shift();
		this._updatedAt = this.deps.now();
		this.broadcast(event);
	}

	private broadcast(event: BridgeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// a misbehaving listener must not break the session.
			}
		}
	}
}
