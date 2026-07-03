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
	type PermissionMode,
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
import type { ExternalActivity } from "./external-activity";
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
/** How many history events are shown initially / loaded per "load older" page. */
const HISTORY_PAGE = 30;

export class SessionActor {
	private readonly input = new AsyncInputQueue<UserInputMessage>();
	private readonly listeners = new Set<Listener>();
	/** count of CLIENT subscribers (excludes the manager's internal aliasing listener). */
	private _clientListeners = 0;
	private readonly buffer: RenderEvent[] = [];
	private readonly pendingPermissions = new Map<string, (r: PermissionResult) => void>();
	private readonly bufferLimit: number;

	private handle: QueryHandle | undefined;
	private started = false;
	private _status: SessionStatus = "idle";
	private _permissionMode: PermissionMode = "default";
	private _external: ExternalActivity = { severity: "none" };
	private _sdkSessionId: string | undefined;
	private _updatedAt: number;
	private _messageCount = 0;
	private pendingRequest: PermissionRequestEvent | undefined;
	private permissionCounter = 0;
	/** older history events not yet sent to clients (oldest-first), for paging. */
	private olderHistory: RenderEvent[] = [];

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

	/**
	 * True while at least one destructive-tool permission is awaiting a user decision.
	 * The actor must NOT be interrupted/dropped in this state: interrupting the query
	 * abandons the pending `canUseTool` promise, and the SDK then records the tool as
	 * rejected with no user Allow/Deny (the "rejected without interaction" bug).
	 */
	get hasPendingPermissions(): boolean {
		return this.pendingPermissions.size > 0;
	}

	get externalActivity(): ExternalActivity {
		return this._external;
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	/** Number of attached CLIENTS (for idle-reaping / poll gating). */
	get clientListenerCount(): number {
		return this._clientListeners;
	}

	/** Epoch ms of the last activity (status change / turn), for idle-reaping. */
	get updatedAt(): number {
		return this._updatedAt;
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
			permissionMode: this._permissionMode,
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
		// Persist the user turn for replay-on-reattach. The live client already shows
		// it optimistically, so we DON'T broadcast it (that would double it) — we only
		// keep it in the buffer so a reconnect's replay restores the full exchange.
		this.bufferOnly({ type: "user_echo", sessionId: this.id, text });
		this.input.push({ type: "user", message: { role: "user", content: text } });
		this.setStatus("working");
	}

	/** Cancel the in-flight turn. */
	async interrupt(): Promise<void> {
		if (this.pendingPermissions.size > 0) {
			// Diagnostic: interrupting while a permission is outstanding abandons it; the
			// SDK then records the tool as rejected with NO user decision. This is the
			// suspected source of "rejected without interaction" (see reload/drop path).
			console.warn(
				`[occ][perm] interrupt() with ${this.pendingPermissions.size} pending permission(s) session=${this.id} ids=[${[...this.pendingPermissions.keys()].join(",")}]`
			);
		}
		await this.handle?.interrupt();
	}

	/** Change the agent permission mode (applies to subsequent tool calls). */
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		try {
			await this.handle?.setPermissionMode(mode);
			this._permissionMode = mode; // only commit on success
			this.broadcast(this.statusEvent());
		} catch (err) {
			// A rejected control request must never crash the server; surface it.
			const message = err instanceof Error ? err.message : String(err);
			this.broadcast({ type: "error", sessionId: this.id, message: `Couldn't change mode: ${message}` });
		}
	}

	/** Update the external-activity state (corruption guard); broadcast on change. */
	setExternalActivity(act: ExternalActivity): void {
		if (
			act.severity === this._external.severity &&
			act.pid === this._external.pid &&
			act.entrypoint === this._external.entrypoint
		) {
			return;
		}
		this._external = act;
		this.broadcast({
			type: "external_activity",
			sessionId: this.id,
			severity: act.severity,
			entrypoint: act.entrypoint,
			pid: act.pid,
		});
	}

	/** Resolve a pending destructive-tool permission request. */
	decidePermission(toolUseId: string, allow: boolean, message?: string): void {
		const resolve = this.pendingPermissions.get(toolUseId);
		if (!resolve) return;
		this.pendingPermissions.delete(toolUseId);
		if (this.pendingRequest?.toolUseId === toolUseId) this.pendingRequest = undefined;
		console.log(`[occ][perm] ${allow ? "ALLOW" : "DENY"} (user) session=${this.id} id=${toolUseId}`);
		if (allow) {
			resolve({ behavior: "allow", updatedInput: this.lastInputs.get(toolUseId) ?? {} });
		} else {
			resolve({ behavior: "deny", message: message ?? "Denied by user" });
		}
		this.setStatus(this.pendingPermissions.size > 0 ? "awaiting_permission" : "working");
	}

	/**
	 * Resolve EVERY outstanding permission as an explicit deny. Used when reaping a
	 * long-abandoned request (client gone, unanswered): unlike an interrupt/drop —
	 * which abandons the `canUseTool` promise and makes the SDK phantom-reject with
	 * no decision — this hands the SDK a concrete "deny" so the turn resumes cleanly
	 * and the transcript records a real decision. The turn then completes and the
	 * actor falls idle, so the normal idle sweep frees the subprocess.
	 */
	autoDenyPending(reason: string): void {
		if (this.pendingPermissions.size === 0) return;
		for (const [toolUseId, resolve] of this.pendingPermissions) {
			console.warn(`[occ][perm] DENY (auto: expired) session=${this.id} id=${toolUseId}`);
			resolve({ behavior: "deny", message: reason });
		}
		this.pendingPermissions.clear();
		this.pendingRequest = undefined;
		this.setStatus("working");
	}

	/**
	 * Attach a client. Replays the buffered transcript, then the live tail.
	 * Sends a fresh status and re-surfaces any still-pending permission request.
	 * @returns an unsubscribe function.
	 */
	subscribe(listener: Listener, opts?: { internal?: boolean }): () => void {
		// Tell the client to clear its transcript BEFORE the replay, so a reconnect
		// re-attach rebuilds cleanly instead of appending a duplicate history.
		if (!opts?.internal) listener({ type: "attach_reset", sessionId: this.id });
		for (const event of this.buffer) listener(event);
		listener(this.statusEvent());
		if (this.pendingRequest) listener(this.pendingRequest);
		// Re-surface live (non-buffered) flags so a re-attaching client shows the banner.
		if (this._external.severity !== "none") {
			listener({
				type: "external_activity",
				sessionId: this.id,
				severity: this._external.severity,
				entrypoint: this._external.entrypoint,
				pid: this._external.pid,
			});
		}
		this.listeners.add(listener);
		if (!opts?.internal) this._clientListeners += 1;
		return () => {
			this.listeners.delete(listener);
			if (!opts?.internal) this._clientListeners = Math.max(0, this._clientListeners - 1);
		};
	}

	/**
	 * Pre-fill the replay buffer with a resumed session's prior transcript. Only
	 * the most recent page is shown on attach; older events are retained for
	 * on-demand paging via {@link loadOlderPage}. Call before any attach.
	 */
	seedHistory(events: RenderEvent[]): void {
		const split = Math.max(0, events.length - HISTORY_PAGE);
		this.olderHistory = events.slice(0, split);
		for (const event of events.slice(split)) {
			this.buffer.push(event);
			if (this.buffer.length > this.bufferLimit) this.buffer.shift();
		}
	}

	/** Pop the next older page of history (most-recent older events first to prepend). */
	loadOlderPage(): { events: RenderEvent[]; hasMore: boolean } {
		const start = Math.max(0, this.olderHistory.length - HISTORY_PAGE);
		const events = this.olderHistory.slice(start);
		this.olderHistory = this.olderHistory.slice(0, start);
		return { events, hasMore: this.olderHistory.length > 0 };
	}

	statusEvent(): SessionStatusEvent {
		return {
			type: "session_status",
			sessionId: this.id,
			status: this._status,
			model: this.opts.model,
			cwd: this.opts.cwd,
			isWriter: false, // the transport rewrites this per-connection.
			hasOlderHistory: this.olderHistory.length > 0,
			permissionMode: this._permissionMode,
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
		console.log(`[occ][perm] REQUEST session=${this.id} tool=${toolName} id=${toolUseId}`);
		// Diagnostic: if the SDK aborts this tool (interrupt / query teardown) while we're
		// still waiting, the permission resolves with NO user decision. Log it so we can
		// confirm the "rejected without interaction" reports against the reload/drop path.
		opts.signal?.addEventListener(
			"abort",
			() => {
				if (this.pendingPermissions.has(toolUseId)) {
					console.warn(`[occ][perm] ABORTED (signal, no user decision) session=${this.id} tool=${toolName} id=${toolUseId}`);
				}
			},
			{ once: true }
		);
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

	/** Append to the replay buffer WITHOUT broadcasting (for already-shown events). */
	private bufferOnly(event: RenderEvent): void {
		this.buffer.push(event);
		if (this.buffer.length > this.bufferLimit) this.buffer.shift();
	}

	private record(event: RenderEvent): void {
		this.bufferOnly(event);
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
