/**
 * Connection — the per-client protocol state machine. Decoupled from the `ws`
 * library: it consumes already-parsed `ClientMessage`s and emits `BridgeEvent`s
 * through an injected `send`, so it is fully unit-testable. `ws-transport.ts` is
 * the thin shell that parses frames and pumps them through here.
 *
 * Enforces: bearer-token auth on `hello`; single-writer input per session
 * (mirrored read-only for additional clients); per-connection `isWriter`
 * rewriting of `session_status`.
 */

import type { BridgeEvent, ClientMessage } from "@occ/protocol";
import { PROTOCOL_VERSION } from "@occ/protocol";
import type { SessionActor } from "./session-actor";
import type { SessionManager } from "./session-manager";

/** Tracks which connection currently "owns" (may write to) each session. */
export interface WriterRegistry {
	claim(actor: SessionActor, conn: object): boolean;
	release(actor: SessionActor, conn: object): void;
	isWriter(actor: SessionActor, conn: object): boolean;
}

export function createWriterRegistry(): WriterRegistry {
	const owners = new Map<SessionActor, object>();
	return {
		claim(actor, conn) {
			const current = owners.get(actor);
			if (current && current !== conn) return false;
			owners.set(actor, conn);
			return true;
		},
		release(actor, conn) {
			if (owners.get(actor) === conn) owners.delete(actor);
		},
		isWriter(actor, conn) {
			return owners.get(actor) === conn;
		},
	};
}

export interface ConnectionDeps {
	manager: SessionManager;
	token: string;
	writers: WriterRegistry;
	send: (event: BridgeEvent) => void;
}

/** Length-independent string compare (avoids trivially leaking token length via early return). */
function safeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

export class Connection {
	private authed = false;
	private attached: { actor: SessionActor; unsubscribe: () => void } | undefined;

	constructor(private readonly deps: ConnectionDeps) {}

	/** Process one client message. Returns `{ close: true }` when the socket should be dropped. */
	handle(msg: ClientMessage): { close?: boolean } {
		if (msg.type === "hello") return this.onHello(msg);
		if (!this.authed) {
			this.deps.send({ type: "error", message: "Not authenticated: send hello first." });
			return { close: true };
		}
		switch (msg.type) {
			case "user_message":
				this.onUserMessage(msg.sessionId, msg.text);
				return {};
			case "permission_decision":
				this.withActor(msg.sessionId, (a) => a.decidePermission(msg.toolUseId, msg.allow, msg.message));
				return {};
			case "interrupt":
				this.withActor(msg.sessionId, (a) => void a.interrupt());
				return {};
			case "new_session":
				this.onNewSession(msg.model);
				return {};
			case "resume_session":
				this.onResume(msg.sessionId, msg.reload ?? false);
				return {};
			case "rename_session":
				this.onRename(msg.sessionId, msg.title);
				return {};
			case "delete_session":
				this.onDelete(msg.sessionId);
				return {};
			case "close_session":
				// Detach + release for a clean CLI hand-off (does NOT delete the store).
				if (this.attached?.actor.id === msg.sessionId) this.detach();
				this.deps.manager.releaseSession(msg.sessionId);
				return {};
			case "load_older":
				this.withActor(msg.sessionId, (actor) => {
					const { events, hasMore } = actor.loadOlderPage();
					this.deps.send({ type: "history_page", sessionId: actor.id, events, hasMore });
				});
				return {};
			case "set_permission_mode":
				this.withActor(msg.sessionId, (actor) => void actor.setPermissionMode(msg.mode));
				return {};
			case "list_sessions":
				this.deps.manager
					.listSummaries()
					.then((sessions) => this.deps.send({ type: "sessions_list", sessions }))
					.catch(() => this.deps.send({ type: "sessions_list", sessions: this.deps.manager.list() }));
				return {};
			case "ping":
				this.deps.send({ type: "pong" });
				return {};
			default:
				return {};
		}
	}

	/** Tear down on socket close. */
	close(): void {
		this.detach();
	}

	// -- handlers ------------------------------------------------------------

	private onHello(msg: Extract<ClientMessage, { type: "hello" }>): { close?: boolean } {
		if (!safeEqual(msg.token ?? "", this.deps.token)) {
			this.deps.send({ type: "error", message: "Invalid token." });
			return { close: true };
		}
		this.authed = true;
		this.deps.send({ type: "ready", protocolVersion: PROTOCOL_VERSION });
		// Fire-and-forget: `ready` is already sent above; the attach may need to resume
		// the session from disk (reconnect after the in-memory actor was reaped).
		if (msg.attach) void this.attachByIdOrError(msg.attach);
		return {};
	}

	private onUserMessage(sessionId: string, text: string): void {
		this.withActor(sessionId, (actor) => {
			if (this.attached?.actor !== actor) this.attach(actor);
			if (!this.deps.writers.claim(actor, this)) {
				this.deps.send({
					type: "error",
					sessionId: actor.id,
					message: "Another client is the active writer for this session.",
				});
				return;
			}
			// A brand-new session (no SDK id yet) can't be open elsewhere; enqueue
			// synchronously. Identified sessions go through the read-only guard.
			if (!actor.sdkSessionId) {
				actor.enqueue(text);
				return;
			}
			void this.guardedEnqueue(actor, text);
		});
	}

	/** Refuse a turn while the session is open in a live external (CLI) process. */
	private async guardedEnqueue(actor: SessionActor, text: string): Promise<void> {
		if ((await this.deps.manager.sendGate(actor)) === "external") {
			this.deps.send({ type: "send_blocked", sessionId: actor.id, reason: "external" });
			return;
		}
		actor.enqueue(text);
	}

	private onNewSession(model?: string): void {
		const actor = this.deps.manager.create(model);
		this.deps.writers.claim(actor, this); // the creator is the writer
		this.attach(actor); // attach AFTER claiming so the first status reports isWriter:true
	}

	/** Attach to a session named in `hello`, resuming it from disk if it was reaped. */
	private async attachByIdOrError(sessionId: string): Promise<void> {
		try {
			const actor = await this.deps.manager.attachOrResume(sessionId);
			if (actor) this.attach(actor);
			else this.deps.send({ type: "error", sessionId, message: `Session not found (${sessionId}) — it may have been deleted.` });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.deps.send({ type: "error", sessionId, message: `Failed to attach: ${message}` });
		}
	}

	private onResume(sessionId: string, reload: boolean): void {
		const resumed = reload
			? this.deps.manager.reloadSession(sessionId)
			: this.deps.manager.resumeWithHistory(sessionId);
		resumed
			.then((actor) => this.attach(actor))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				this.deps.send({ type: "error", sessionId, message: `Failed to resume: ${message}` });
			});
	}

	private onRename(sessionId: string, title: string): void {
		this.deps.manager
			.renameSession(sessionId, title)
			.then(() => this.deps.manager.listSummaries())
			.then((sessions) => this.deps.send({ type: "sessions_list", sessions }))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				this.deps.send({ type: "error", sessionId, message: `Rename failed: ${message}` });
			});
	}

	private onDelete(sessionId: string): void {
		// If we're viewing the session being deleted, detach first.
		if (this.attached?.actor.id === sessionId) this.detach();
		this.deps.manager
			.deleteSession(sessionId)
			.then(() => this.deps.manager.listSummaries())
			.then((sessions) => this.deps.send({ type: "sessions_list", sessions }))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				this.deps.send({ type: "error", sessionId, message: `Delete failed: ${message}` });
			});
	}

	private withActor(sessionId: string, fn: (actor: SessionActor) => void): void {
		const actor = this.deps.manager.get(sessionId);
		if (!actor) {
			this.deps.send({ type: "error", sessionId, message: `No such session: ${sessionId}` });
			return;
		}
		fn(actor);
	}

	// -- attach / forward ----------------------------------------------------

	private attach(actor: SessionActor): void {
		if (this.attached?.actor === actor) return;
		this.detach();
		const unsubscribe = actor.subscribe((event) => this.forward(actor, event));
		this.attached = { actor, unsubscribe };
	}

	private detach(): void {
		if (!this.attached) return;
		this.attached.unsubscribe();
		this.deps.writers.release(this.attached.actor, this);
		this.attached = undefined;
	}

	private forward(actor: SessionActor, event: BridgeEvent): void {
		if (event.type === "session_status") {
			this.deps.send({ ...event, isWriter: this.deps.writers.isWriter(actor, this) });
		} else {
			this.deps.send(event);
		}
	}
}
