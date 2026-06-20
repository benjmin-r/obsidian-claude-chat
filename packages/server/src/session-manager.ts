/**
 * SessionManager — owns the set of live SessionActors, keyed by every id they
 * are known by (provisional handle id + the canonical SDK session id once the
 * query reports it). A new session starts under a provisional id; when the SDK
 * `system/init` arrives, the manager registers the real id too, so clients that
 * still hold the provisional id keep resolving to the same actor.
 */

import { mapHistoryMessages, type SessionSummary } from "@occ/protocol";
import { SessionActor, type SessionActorDeps } from "./session-actor";
import type { ListStored, LoadHistory } from "./ports";

export interface SessionManagerConfig {
	cwd: string;
	defaultModel: string;
	bufferLimit?: number;
}

export interface SessionManagerDeps extends SessionActorDeps {
	/** generates unique provisional handle ids. */
	newHandleId: () => string;
	/** enumerate persisted sessions from the CLI store. */
	listStored: ListStored;
	/** load a persisted session's prior transcript. */
	loadHistory: LoadHistory;
}

export class SessionManager {
	private readonly index = new Map<string, SessionActor>();
	private readonly actors = new Set<SessionActor>();

	constructor(
		private readonly deps: SessionManagerDeps,
		private readonly config: SessionManagerConfig
	) {}

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
		return actor;
	}

	get(id: string): SessionActor | undefined {
		return this.index.get(id);
	}

	list(): SessionSummary[] {
		return [...this.actors].map((a) => a.summary());
	}

	/** Active in-memory sessions merged with persisted ones from the store, newest first. */
	async listSummaries(): Promise<SessionSummary[]> {
		const active = this.list();
		const activeIds = new Set(active.map((s) => s.sessionId));
		let stored: SessionSummary[] = [];
		try {
			stored = (await this.deps.listStored(this.config.cwd))
				.filter((s) => !activeIds.has(s.sessionId))
				.map((s) => ({
					sessionId: s.sessionId,
					title: s.title,
					model: this.config.defaultModel,
					status: "idle" as const,
					cwd: this.config.cwd,
					updatedAt: s.updatedAt,
				}));
		} catch {
			stored = [];
		}
		return [...active, ...stored].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	}

	private register(actor: SessionActor, id: string): void {
		this.actors.add(actor);
		this.index.set(id, actor);
		// Learn the canonical SDK id as soon as it is reported, and alias it.
		actor.subscribe(() => {
			const sid = actor.sdkSessionId;
			if (sid && this.index.get(sid) !== actor) this.index.set(sid, actor);
		});
	}
}
