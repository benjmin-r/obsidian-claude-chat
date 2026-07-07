/**
 * Linking to Claude chat conversations from notes.
 *
 * A conversation link is a normal markdown link to an `obsidian://occ-chat?session=<id>`
 * URI, which the plugin's protocol handler (main.ts) routes to the chat view. Two entry
 * points share the fetch + insert logic here:
 *  - `ConversationSuggest`: an editor autocomplete triggered by typing `/occ` in a note.
 *  - `SessionLinkModal`: a fuzzy picker opened by the "Insert link to a Claude
 *    conversation" command (discoverable; works anywhere in the editor).
 *
 * Sessions are fetched over a short-lived WebSocket (independent of the chat view's
 * persistent connection) and cached briefly so per-keystroke autocomplete stays cheap.
 */

import {
	type App,
	type Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	FuzzySuggestModal,
	Notice,
	type TFile,
} from "obsidian";
import type { SessionSummary } from "@occ/protocol";

/** Build the routable URI for a session (optionally deep-linking a message — Phase 2). */
export function occChatUri(sessionId: string, messageId?: string): string {
	const base = `obsidian://occ-chat?session=${encodeURIComponent(sessionId)}`;
	return messageId ? `${base}&msg=${encodeURIComponent(messageId)}` : base;
}

/** Human label for a session, mirroring the picker ("New session" when untitled). */
export function sessionLabel(s: SessionSummary): string {
	return (s.title && s.title.trim()) || "New Claude session";
}

/** A markdown link to a conversation (optionally deep-linking a message by uuid). */
export function conversationLinkFromParts(sessionId: string, title?: string, messageId?: string): string {
	const label = (title && title.trim()) || "New Claude session";
	return `[${label}](${occChatUri(sessionId, messageId)})`;
}

/** A markdown link to a conversation, e.g. `[My chat](obsidian://occ-chat?session=…)`. */
export function conversationLinkMarkdown(s: SessionSummary): string {
	return conversationLinkFromParts(s.sessionId, s.title);
}

/**
 * Detect a `/occ [query]` trigger at the end of `before` (the line text up to the caret).
 * The `/occ` must start the line or follow whitespace; the query can't contain a slash so
 * it never swallows a path. Returns the query and the caret-offset where `/occ` begins.
 * Pure, so the trigger logic is unit-tested without an Editor. */
export function matchOccTrigger(before: string): { query: string; startCh: number } | null {
	const m = before.match(/\/occ(?:\s+([^/\n]*))?$/);
	if (!m) return null;
	const startCh = before.length - m[0].length;
	if (startCh > 0 && !/\s/.test(before[startCh - 1]!)) return null; // must be at a word boundary
	return { query: m[1] ?? "", startCh };
}

/**
 * One-shot fetch of the session list over a short-lived WebSocket. Separate from the
 * chat view's persistent socket; `list_sessions` is safe from any connection. Resolves
 * with the sessions (newest first) or rejects on auth/URL/timeout error.
 */
export function fetchSessions(url: string, token: string, timeoutMs = 6000): Promise<SessionSummary[]> {
	return new Promise((resolve, reject) => {
		if (!url.trim()) {
			reject(new Error("No server URL configured (Claude Chat settings)."));
			return;
		}
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			reject(new Error(`Invalid server URL: ${url}`));
			return;
		}
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("Timed out fetching sessions."))), timeoutMs);
		ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token }));
		ws.onerror = () => finish(() => reject(new Error("Couldn't reach the Claude server.")));
		ws.onmessage = (ev) => {
			let msg: { type?: string; sessions?: SessionSummary[]; message?: string };
			try {
				msg = JSON.parse(String((ev as MessageEvent).data));
			} catch {
				return;
			}
			if (msg.type === "ready") ws.send(JSON.stringify({ type: "list_sessions" }));
			else if (msg.type === "sessions_list") {
				const sessions = (msg.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
				finish(() => resolve(sessions));
			} else if (msg.type === "error") finish(() => reject(new Error(msg.message ?? "Server error.")));
		};
	});
}

/** Settings the link helpers need from the plugin (kept minimal to avoid a hard dep). */
export interface LinkHost {
	app: App;
	settings: { serverUrl: string; token: string };
}

/** Short-lived cache so per-keystroke autocomplete doesn't reconnect each time. */
class SessionCache {
	private cache: { at: number; sessions: SessionSummary[] } | undefined;
	constructor(
		private readonly host: LinkHost,
		private readonly ttlMs = 10_000
	) {}

	async get(): Promise<SessionSummary[]> {
		const now = Date.now();
		if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.sessions;
		try {
			const sessions = await fetchSessions(this.host.settings.serverUrl, this.host.settings.token);
			this.cache = { at: now, sessions };
			return sessions;
		} catch {
			return this.cache?.sessions ?? []; // fall back to stale data; suggest just shows fewer/none
		}
	}
}

/** Insert a conversation link over `[start, end)` (or at the cursor) and place the caret after it. */
function replaceWithLink(editor: Editor, start: EditorPosition, end: EditorPosition, session: SessionSummary): void {
	const link = conversationLinkMarkdown(session);
	editor.replaceRange(link, start, end);
	editor.setCursor({ line: start.line, ch: start.ch + link.length });
}

const MAX_SUGGESTIONS = 8;

/** `/occ`-triggered editor autocomplete that inserts a conversation link. */
export class ConversationSuggest extends EditorSuggest<SessionSummary> {
	private readonly sessions: SessionCache;

	constructor(private readonly host: LinkHost) {
		super(host.app);
		this.sessions = new SessionCache(host);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const hit = matchOccTrigger(before);
		if (!hit) return null;
		return { start: { line: cursor.line, ch: hit.startCh }, end: cursor, query: hit.query };
	}

	async getSuggestions(context: EditorSuggestContext): Promise<SessionSummary[]> {
		const all = await this.sessions.get();
		const q = context.query.trim().toLowerCase();
		const matched = q ? all.filter((s) => sessionLabel(s).toLowerCase().includes(q)) : all;
		return matched.slice(0, MAX_SUGGESTIONS);
	}

	renderSuggestion(session: SessionSummary, el: HTMLElement): void {
		el.createDiv({ cls: "occ-link-suggest-title", text: sessionLabel(session) });
		const when = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "";
		if (when) el.createDiv({ cls: "occ-link-suggest-meta", text: when });
	}

	selectSuggestion(session: SessionSummary): void {
		if (!this.context) return;
		replaceWithLink(this.context.editor, this.context.start, this.context.end, session);
	}
}

/** Fuzzy picker for the "Insert link to a Claude conversation" command. */
export class SessionLinkModal extends FuzzySuggestModal<SessionSummary> {
	constructor(
		app: App,
		private readonly sessions: SessionSummary[],
		private readonly onChoose: (s: SessionSummary) => void
	) {
		super(app);
		this.setPlaceholder("Pick a Claude conversation to link…");
	}

	getItems(): SessionSummary[] {
		return this.sessions;
	}

	getItemText(s: SessionSummary): string {
		return sessionLabel(s);
	}

	onChooseItem(s: SessionSummary): void {
		this.onChoose(s);
	}
}

/** Command handler: fetch sessions, let the user pick one, insert the link at the cursor. */
export async function insertConversationLink(host: LinkHost, editor: Editor): Promise<void> {
	let sessions: SessionSummary[];
	try {
		sessions = await fetchSessions(host.settings.serverUrl, host.settings.token);
	} catch (e) {
		new Notice(`Claude Chat: ${e instanceof Error ? e.message : "couldn't load sessions"}`);
		return;
	}
	if (sessions.length === 0) {
		new Notice("Claude Chat: no conversations found.");
		return;
	}
	new SessionLinkModal(host.app, sessions, (s) => {
		const cursor = editor.getCursor();
		replaceWithLink(editor, cursor, cursor, s);
	}).open();
}
