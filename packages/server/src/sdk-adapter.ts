/**
 * Thin I/O shell around the Claude Agent SDK `query()`. This is the ONLY module
 * that imports the SDK; it is excluded from coverage and never loaded by unit
 * tests (the core takes `RunQuery` as an injected port).
 *
 * Auth: we pass NO apiKey and rely on the subscription session in ~/.claude.
 * `ANTHROPIC_API_KEY` must remain unset in the process env (see config.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSession, getSessionMessages, listSessions, query, renameSession } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessage } from "@occ/protocol";
import { classifyHolders, isDescendant, parseEntry, type RegistryEntry } from "./external-activity";
import { sweepOrphanedAgents } from "./orphan-sweep";
import type {
	DeleteStored,
	DetectExternalActivity,
	ListStored,
	LoadHistory,
	QueryHandle,
	RenameStored,
	RunQuery,
} from "./ports";

/** The subset of the SDK `Query` (an AsyncGenerator) that we drive. */
interface SdkQuery extends AsyncGenerator<unknown, void> {
	interrupt(): Promise<void>;
	setPermissionMode(mode: string): Promise<void>;
	/** Forcefully ends the query and terminates the CLI subprocess (per SDK docs). */
	close(): void;
}

export const runQuery: RunQuery = (prompt, options) => {
	const q = query({
		// The SDK accepts an AsyncIterable<SDKUserMessage> as a streaming prompt.
		prompt: prompt as never,
		options: {
			cwd: options.cwd,
			model: options.model,
			permissionMode: options.permissionMode, // 'default' routes tools through canUseTool
			includePartialMessages: true, // incremental text streaming
			canUseTool: options.canUseTool as never,
			...(options.resume ? { resume: options.resume } : {}),
		} as never,
	}) as unknown as SdkQuery;

	// Wrap (not mutate) the SDK object so `dispose()` can close the generator — the
	// ONLY thing that terminates the CLI subprocess. `interrupt()` cancels the turn
	// but leaves the child resident; without dispose, every drop/reap orphans one.
	const handle: QueryHandle = {
		[Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() as AsyncIterator<SdkMessage>,
		interrupt: () => q.interrupt(),
		setPermissionMode: (mode) => q.setPermissionMode(mode),
		dispose: async () => {
			try {
				// close() (NOT return()) is what actually terminates the CLI subprocess —
				// it forcefully ends the query and cleans up the child + MCP transports.
				q.close();
			} catch {
				// best-effort teardown; the actor is being discarded regardless.
			}
		},
	};
	return handle;
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

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

/** Is `pid` running? `EPERM` means it exists but isn't ours; `ESRCH` means gone. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read a process's parent pid from /proc; undefined if unavailable. */
function parentOf(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) is parenthesised and may contain spaces/parens, so slice
		// after the last ')': the remainder is "<state> <ppid> …".
		const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
		const ppid = Number(after[1]);
		return Number.isFinite(ppid) ? ppid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Kill Agent-SDK subprocesses orphaned by a previous server run (hard crash). Call
 * once at startup, before any session spawns. Best-effort; returns the pids swept.
 */
export function sweepOrphanedAgentsFromProc(): number[] {
	return sweepOrphanedAgents({
		ownPid: process.pid,
		listPids: () => {
			try {
				return fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
			} catch {
				return []; // no /proc (non-Linux) → nothing to sweep
			}
		},
		cmdline: (pid) => {
			try {
				return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
			} catch {
				return undefined; // process gone / unreadable
			}
		},
		parentOf,
		kill: (pid) => {
			try {
				process.kill(pid, "SIGTERM");
				return true;
			} catch {
				return false; // already gone / not permitted
			}
		},
	});
}

/**
 * Read the live-process registry and classify activity for one session. Our own
 * SDK query subprocesses are excluded via pid-tree descent from this process.
 */
export const detectExternalActivity: DetectExternalActivity = (cwd, sessionId) => {
	let files: string[];
	try {
		files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return { severity: "none" }; // registry absent → no guard
	}
	const entries: RegistryEntry[] = [];
	for (const f of files) {
		try {
			const e = parseEntry(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
			if (e) entries.push(e);
		} catch {
			// skip unreadable/partial files
		}
	}
	const ownPid = process.pid;
	return classifyHolders(entries, {
		sessionId,
		vaultCwd: cwd,
		isAlive,
		isOwn: (pid) => isDescendant(pid, ownPid, parentOf),
	});
};
