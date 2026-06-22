/**
 * SessionManager — owns the set of live SessionActors, keyed by every id they
 * are known by (provisional handle id + the canonical SDK session id once the
 * query reports it). A new session starts under a provisional id; when the SDK
 * `system/init` arrives, the manager registers the real id too, so clients that
 * still hold the provisional id keep resolving to the same actor.
 */

import { mapHistoryMessages, type SessionSummary } from "@occ/protocol";
import { SessionActor, type SessionActorDeps } from "./session-actor";
import type {
	DeleteStored,
	DetectExternalActivity,
	ListStored,
	LoadHistory,
	RenameStored,
	SessionLastModified,
} from "./ports";

export interface SessionManagerConfig {
	cwd: string;
	defaultModel: string;
	bufferLimit?: number;
}

/** Result of the pre-send guard. */
export type SendGate = "ok" | "stale" | "external_busy" | "external_idle";

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
	/** detect a live foreign holder of a session (corruption guard); optional. */
	detectExternalActivity?: DetectExternalActivity;
	/** on-disk last-modified time of a session (staleness); optional. */
	sessionLastModified?: SessionLastModified;
}

export class SessionManager {
	private readonly index = new Map<string, SessionActor>();
	private readonly actors = new Set<SessionActor>();
	/** unsubscribe for each actor's internal id-aliasing listener (cleared on drop). */
	private readonly aliasUnsub = new Map<SessionActor, () => void>();

	private readonly detect: DetectExternalActivity;
	private readonly lastModified: SessionLastModified;
	private static readonly STALE_SLACK_MS = 3000;

	constructor(
		private readonly deps: SessionManagerDeps,
		private readonly config: SessionManagerConfig
	) {
		this.detect = deps.detectExternalActivity ?? (() => ({ severity: "none" }));
		this.lastModified = deps.sessionLastModified ?? (async () => undefined);
	}

	/** Refresh external-activity + staleness for every attached, identified session. */
	pollExternalActivity(): void {
		for (const actor of this.actors) {
			const sid = actor.sdkSessionId;
			if (!sid || actor.clientListenerCount === 0) continue;
			actor.setExternalActivity(this.detect(this.config.cwd, sid));
			void this.refreshStale(actor, sid);
		}
	}

	/** Release actors idle longer than maxIdleMs with no attached clients. */
	reapIdle(maxIdleMs: number): void {
		const now = this.deps.now();
		for (const actor of [...this.actors]) {
			if (actor.status === "idle" && actor.clientListenerCount === 0 && now - actor.updatedAt > maxIdleMs) {
				this.dropActor(actor);
			}
		}
	}

	private async refreshStale(actor: SessionActor, sid: string): Promise<void> {
		const mtime = await this.lastModified(this.config.cwd, sid);
		if (mtime === undefined) return;
		actor.setStale(mtime > actor.selfMtime + SessionManager.STALE_SLACK_MS);
	}

	/**
	 * Fresh pre-send guard (also refreshes the actor's banners). Staleness takes
	 * precedence and is never overridable; external activity is overridable by the
	 * caller. A brand-new session (no SDK id yet) is always 'ok'.
	 */
	async sendGate(actor: SessionActor): Promise<SendGate> {
		const sid = actor.sdkSessionId;
		if (!sid) return "ok";
		const mtime = await this.lastModified(this.config.cwd, sid);
		const stale = mtime !== undefined && mtime > actor.selfMtime + SessionManager.STALE_SLACK_MS;
		actor.setStale(stale);
		const act = this.detect(this.config.cwd, sid);
		actor.setExternalActivity(act);
		if (stale) return "stale";
		if (act.severity === "busy") return "external_busy";
		if (act.severity === "idle") return "external_idle";
		return "ok";
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
			// Baseline staleness against the file's current mtime (we're now in sync).
			const mtime = await this.lastModified(this.config.cwd, sessionId);
			if (mtime !== undefined) actor.markSelfMtime(mtime);
		} catch {
			// history is best-effort; resume still works for the next turn.
		}
		return actor;
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
