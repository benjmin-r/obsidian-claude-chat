/**
 * Pure conversation-link helpers — no Obsidian imports. Split out of
 * `link-insert.ts` (which pulls in real Obsidian runtime classes at module
 * scope: `EditorSuggest`, `FuzzySuggestModal`, `Notice`) so these can be
 * imported by code that must stay Obsidian-free, e.g. `export-markdown.ts`/
 * `export-html.ts`, which run standalone under plain Node (unit tests, the
 * fixture preview script) with no Obsidian runtime available.
 */

import type { SessionSummary } from "@occ/protocol";

/** Build the routable URI for a session (optionally deep-linking a message). */
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
