/**
 * SessionManager — owns the set of live SessionActors, keyed by every id they
 * are known by (provisional handle id + the canonical SDK session id once the
 * query reports it). A new session starts under a provisional id; when the SDK
 * `system/init` arrives, the manager registers the real id too, so clients that
 * still hold the provisional id keep resolving to the same actor.
 */

import { mapHistoryMessages, type SessionSummary } from "@occ/protocol";
import { SessionActor, type SessionActorDeps } from "./session-actor";
import type { DeleteStored, DetectExternalActivity, ListStored, LoadHistory, RenameStored } from "./ports";

export interface SessionManagerConfig {
	cwd: string;
	defaultModel: string;
	bufferLimit?: number;
}

/** Result of the pre-send guard. */
export type SendGate = "ok" | "external";

export interface SessionManagerDeps extends SessionActorDeps {
	/** generates unique provisional handle ids. */
	newHandleId: () => string;
	/** enumerate persisted sessions from the CLI store. */
	listStored: ListStored;
	/** load a persisted session's prior transcript. */
	loadHistory: LoadHistory;
	/** set a persisted session's title. */
	renameStored: RenameStored;
	/** permanently delete a persisted session. */
	deleteStored: DeleteStored;
	/** detect a live external (CLI) holder of a session → read-only; optional. */
	detectExternalActivity?: DetectExternalActivity;
}

export class SessionManager {
	private readonly index = new Map<string, SessionActor>();
	private readonly actors = new Set<SessionActor>();
	/** unsubscribe for each actor's internal id-aliasing listener (cleared on drop). */
	private readonly aliasUnsub = new Map<SessionActor, () => void>();

	private readonly detect: DetectExternalActivity;

	constructor(
		private readonly deps: SessionManagerDeps,
		private readonly config: SessionManagerConfig
	) {
		this.detect = deps.detectExternalActivity ?? (() => ({ severity: "none" }));
	}

	/**
	 * Sweep detached actors: release idle ones older than `maxIdleMs`, and auto-deny
	 * permission prompts abandoned longer than `permissionMaxIdleMs` (defaults to
	 * `maxIdleMs`). An awaiting-permission actor can't be dropped directly — that
	 * would abandon its `canUseTool` promise and make the SDK phantom-reject — so we
	 * resolve the prompt as an explicit deny; the turn then falls idle and a later
	 * sweep frees it via the idle path. Attached actors (a client may still answer)
	 * are always left alone.
	 */
	reapIdle(maxIdleMs: number, permissionMaxIdleMs = maxIdleMs): void {
		const now = this.deps.now();
		for (const actor of [...this.actors]) {
			if (actor.clientListenerCount !== 0) continue;
			const age = now - actor.updatedAt;
			if (actor.status === "idle" && age > maxIdleMs) {
				this.dropActor(actor);
			} else if (actor.status === "awaiting_permission" && age > permissionMaxIdleMs) {
				actor.autoDenyPending("Auto-denied: permission request expired without a response.");
			}
		}
	}

	/**
	 * Pre-send guard: refuse a turn while a live external process holds the session
	 * (the plugin is read-only then). A brand-new session (no SDK id yet) is 'ok'.
	 */
	async sendGate(actor: SessionActor): Promise<SendGate> {
		const sid = actor.sdkSessionId;
		if (!sid) return "ok";
		const act = this.detect(this.config.cwd, sid);
		actor.setExternalActivity(act);
		return act.severity === "none" ? "ok" : "external";
	}

	/**
	 * Detach-driven release: drop an idle, unlistened actor so the CLI gets a clean
	 * hand-off (its query subprocess is interrupted/freed). No-op if still in use.
	 */
	releaseSession(sessionId: string): void {
		const actor = this.index.get(sessionId);
		if (actor && actor.status === "idle" && actor.clientListenerCount === 0) this.dropActor(actor);
	}

	/** Start a brand-new session. */
	create(model?: string): SessionActor {
		const handleId = this.deps.newHandleId();
		const actor = new SessionActor(this.deps, {
			handleId,
			cwd: this.config.cwd,
			model: model ?? this.config.defaultModel,
			bufferLimit: this.config.bufferLimit,
		});
		this.register(actor, handleId);
		return actor;
	}

	/** Reattach (in-memory) or reconstruct (resume from the CLI store) a session. */
	resume(sdkSessionId: string, model?: string): SessionActor {
		const existing = this.index.get(sdkSessionId);
		if (existing) return existing;
		const actor = new SessionActor(this.deps, {
			handleId: sdkSessionId,
			cwd: this.config.cwd,
			model: model ?? this.config.defaultModel,
			resume: sdkSessionId,
			bufferLimit: this.config.bufferLimit,
		});
		this.register(actor, sdkSessionId);
		return actor;
	}

	/**
	 * Drop any cached (possibly stale) actor for `id` and reconstruct it fresh from
	 * disk. Used to reconcile after the on-disk transcript advanced externally.
	 * NOTE: other clients attached to the old actor are orphaned until they
	 * re-interact (single-writer is the norm; concurrent multi-client is rare).
	 */
	async reloadSession(sessionId: string): Promise<SessionActor> {
		const existing = this.index.get(sessionId);
		// Never tear down an actor that is awaiting a permission decision. dropActor
		// interrupts the SDK query, which abandons the pending canUseTool promise and
		// makes the SDK record the tool as rejected with no user Allow/Deny (the
		// "permission rejected on reload" bug). The live actor is already current, so
		// just return it — the re-attach re-surfaces the pending request via subscribe().
		if (existing?.hasPendingPermissions) return existing;
		if (existing) this.dropActor(existing);
		return this.resumeWithHistory(sessionId);
	}

	/** Interrupt (best-effort) and remove an actor plus all its id aliases. */
	private dropActor(actor: SessionActor): void {
		// Stop the aliasing listener FIRST, so the interrupt's status broadcast can't
		// re-insert the actor we're about to remove.
		this.aliasUnsub.get(actor)?.();
		this.aliasUnsub.delete(actor);
		void actor.interrupt().catch(() => undefined);
		this.actors.delete(actor);
		for (const [id, a] of [...this.index]) {
			if (a === actor) this.index.delete(id);
		}
	}

	/** Resume a session by id, seeding its replay buffer with the stored transcript. */
	async resumeWithHistory(sessionId: string): Promise<SessionActor> {
		const existing = this.index.get(sessionId);
		if (existing) return existing;
		const actor = new SessionActor(this.deps, {
			handleId: sessionId,
			cwd: this.config.cwd,
			model: this.config.defaultModel,
			resume: sessionId,
			bufferLimit: this.config.bufferLimit,
		});
		this.register(actor, sessionId);
		try {
			const messages = await this.deps.loadHistory(this.config.cwd, sessionId);
			actor.seedHistory(mapHistoryMessages(messages, sessionId));
		} catch {
			// history is best-effort; resume still works for the next turn.
		}
		// Check CLI activity NOW so the (re)attach re-emits the correct read-only state
		// immediately — no "writable→read-only" flicker on pick/reload.
		actor.setExternalActivity(this.detect(this.config.cwd, sessionId));
		return actor;
	}

	/**
	 * Attach to a session for a (re)connecting client: return the live actor if it is
	 * still in memory, else resume it from the CLI store — but ONLY if it actually
	 * exists there. Returns undefined for a genuinely unknown id.
	 *
	 * This is the reconnect path. The idle reaper drops in-memory actors after a few
	 * minutes with no clients, so a client foregrounding after a long background finds
	 * its session gone from memory though still persisted on disk; without this it
	 * would get a spurious "No such session". The existence check is required because
	 * resumeWithHistory swallows load errors and would otherwise fabricate a phantom
	 * actor for a bogus id.
	 */
	async attachOrResume(sessionId: string): Promise<SessionActor | undefined> {
		const existing = this.index.get(sessionId);
		if (existing) return existing;
		let stored: Awaited<ReturnType<ListStored>> = [];
		try {
			stored = await this.deps.listStored(this.config.cwd);
		} catch {
			stored = [];
		}
		if (!stored.some((s) => s.sessionId === sessionId)) return undefined;
		return this.resumeWithHistory(sessionId);
	}

	/** Set a session's display title in the store. */
	async renameSession(sessionId: string, title: string): Promise<void> {
		await this.deps.renameStored(this.config.cwd, sessionId, title);
	}

	/**
	 * Permanently delete a session: remove it from the CLI store AND drop any
	 * live actor (otherwise it would keep running against a deleted store file).
	 * Store deletion is best-effort — a brand-new session may not be persisted yet.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		const actor = this.index.get(sessionId);
		try {
			await this.deps.deleteStored(this.config.cwd, sessionId);
		} catch {
			// not persisted yet (or already gone); still drop the actor below.
		}
		if (actor) this.dropActor(actor);
	}

	get(id: string): SessionActor | undefined {
		return this.index.get(id);
	}

	list(): SessionSummary[] {
		return [...this.actors].map((a) => a.summary());
	}

	/** Active in-memory sessions merged with persisted ones from the store, newest first. */
	async listSummaries(): Promise<SessionSummary[]> {
		let stored: { sessionId: string; title: string; updatedAt: number }[] = [];
		try {
			stored = await this.deps.listStored(this.config.cwd);
		} catch {
			stored = [];
		}
		const storedById = new Map(stored.map((s) => [s.sessionId, s]));

		// Active sessions keep their live status but borrow the stored title — an
		// actor has no title of its own, so without this a resumed (active)
		// session would display its UUID and a rename would never show.
		const active = this.list().map((a) => {
			const info = storedById.get(a.sessionId);
			return info ? { ...a, title: info.title } : a;
		});
		const activeIds = new Set(active.map((s) => s.sessionId));

		const storedOnly: SessionSummary[] = stored
			.filter((s) => !activeIds.has(s.sessionId))
			.map((s) => ({
				sessionId: s.sessionId,
				title: s.title,
				model: this.config.defaultModel,
				status: "idle" as const,
				cwd: this.config.cwd,
				updatedAt: s.updatedAt,
			}));

		return [...active, ...storedOnly].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	}

	private register(actor: SessionActor, id: string): void {
		this.actors.add(actor);
		this.index.set(id, actor);
		// Learn the canonical SDK id as soon as it is reported, and alias it.
		// Internal: must not count as a client listener (idle-reaping depends on that).
		const off = actor.subscribe(
			() => {
				const sid = actor.sdkSessionId;
				if (sid && this.index.get(sid) !== actor) this.index.set(sid, actor);
			},
			{ internal: true }
		);
		this.aliasUnsub.set(actor, off);
	}
}
