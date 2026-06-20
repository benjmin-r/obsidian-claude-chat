/**
 * Thin I/O shell around the Claude Agent SDK `query()`. This is the ONLY module
 * that imports the SDK; it is excluded from coverage and never loaded by unit
 * tests (the core takes `RunQuery` as an injected port).
 *
 * Auth: we pass NO apiKey and rely on the subscription session in ~/.claude.
 * `ANTHROPIC_API_KEY` must remain unset in the process env (see config.ts).
 */

import { deleteSession, getSessionMessages, listSessions, query, renameSession } from "@anthropic-ai/claude-agent-sdk";
import type { DeleteStored, ListStored, LoadHistory, RenameStored, RunQuery } from "./ports";

export const runQuery: RunQuery = (prompt, options) => {
	const q = query({
		// The SDK accepts an AsyncIterable<SDKUserMessage> as a streaming prompt.
		prompt: prompt as never,
		options: {
			cwd: options.cwd,
			model: options.model,
			permissionMode: "default", // route every tool through canUseTool
			includePartialMessages: true, // incremental text streaming
			canUseTool: options.canUseTool as never,
			...(options.resume ? { resume: options.resume } : {}),
		} as never,
	});
	return q as unknown as ReturnType<RunQuery>;
};

/** Enumerate persisted sessions for the vault dir, newest first, titled for display. */
export const listStored: ListStored = async (cwd) => {
	const sessions = await listSessions({ dir: cwd, limit: 50 });
	return sessions.map((s) => ({
		sessionId: s.sessionId,
		title: (s.customTitle || s.summary || s.firstPrompt || s.sessionId).trim(),
		updatedAt: s.lastModified,
	}));
};

/** Load a persisted session's prior messages for transcript replay. */
export const loadHistory: LoadHistory = async (cwd, sessionId) => {
	const messages = await getSessionMessages(sessionId, { dir: cwd });
	return messages.map((m) => ({ type: m.type, message: m.message }));
};

/** Set a persisted session's display title. */
export const renameStored: RenameStored = (cwd, sessionId, title) => renameSession(sessionId, title, { dir: cwd });

/** Permanently delete a persisted session from the store. */
export const deleteStored: DeleteStored = (cwd, sessionId) => deleteSession(sessionId, { dir: cwd });
