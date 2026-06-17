/**
 * SessionManager — owns the set of live SessionActors, keyed by every id they
 * are known by (provisional handle id + the canonical SDK session id once the
 * query reports it). A new session starts under a provisional id; when the SDK
 * `system/init` arrives, the manager registers the real id too, so clients that
 * still hold the provisional id keep resolving to the same actor.
 */

import type { SessionSummary } from "@occ/protocol";
import { SessionActor, type SessionActorDeps } from "./session-actor";

export interface SessionManagerConfig {
	cwd: string;
	defaultModel: string;
	bufferLimit?: number;
}

export interface SessionManagerDeps extends SessionActorDeps {
	/** generates unique provisional handle ids. */
	newHandleId: () => string;
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

	get(id: string): SessionActor | undefined {
		return this.index.get(id);
	}

	list(): SessionSummary[] {
		return [...this.actors].map((a) => a.summary());
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
