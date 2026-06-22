/**
 * Pure logic for detecting whether a session is held by a live process OTHER
 * than this server — the corruption guard's signal. Claude Code maintains a
 * registry of running processes at `~/.claude/sessions/<pid>.json`; the real
 * filesystem + /proc reader lives in `sdk-adapter.ts` (excluded from coverage)
 * and delegates the decision to the pure functions here.
 *
 * Everything in this module is pure (I/O is passed in as predicates), so the
 * classification, cwd-scoping and pid-tree self-exclusion are all unit-tested.
 */

import type { ExternalSeverity } from "@occ/protocol";

/** One parsed `~/.claude/sessions/<pid>.json` entry (the fields we use). */
export interface RegistryEntry {
	pid: number;
	sessionId: string;
	cwd: string;
	/** "cli" | "sdk-cli" | "sdk-ts" | … */
	entrypoint?: string;
	/** "busy" | "idle" | undefined (only populated for interactive `cli`). */
	status?: string;
	procStart?: string;
}

/** A foreign holder of a session, plus its severity. */
export interface ExternalActivity {
	severity: ExternalSeverity;
	pid?: number;
	entrypoint?: string;
}

/** Strip trailing slashes so cwd comparisons are stable. */
export function normalizeCwd(p: string): string {
	return p.replace(/\/+$/, "");
}

/** Parse one registry file's contents; null if malformed or missing required fields. */
export function parseEntry(raw: string): RegistryEntry | null {
	let o: unknown;
	try {
		o = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!o || typeof o !== "object") return null;
	const e = o as Record<string, unknown>;
	if (typeof e.pid !== "number" || typeof e.sessionId !== "string" || typeof e.cwd !== "string") return null;
	return {
		pid: e.pid,
		sessionId: e.sessionId,
		cwd: e.cwd,
		entrypoint: typeof e.entrypoint === "string" ? e.entrypoint : undefined,
		status: typeof e.status === "string" ? e.status : undefined,
		procStart: typeof e.procStart === "string" ? e.procStart : undefined,
	};
}

/**
 * Is `pid` a descendant of `ancestor` (or the ancestor itself)? Walks parent
 * pids via the injected `parentOf` reader. Used to exclude OUR OWN query
 * subprocesses (which the SDK spawns as children of the server process).
 */
export function isDescendant(
	pid: number,
	ancestor: number,
	parentOf: (p: number) => number | undefined,
	maxHops = 64
): boolean {
	let cur: number | undefined = pid;
	for (let i = 0; i <= maxHops && cur !== undefined && cur > 1; i++) {
		if (cur === ancestor) return true;
		cur = parentOf(cur);
	}
	return false;
}

/**
 * Classify the registry for `sessionId` in `vaultCwd`. A holder counts only if
 * it's in the same working dir, alive, and not one of our own subprocesses.
 * 'busy' = a live foreign process mid-turn (or any headless/SDK process, which
 * only persist while running); 'idle' = a parked interactive terminal.
 */
export function classifyHolders(
	entries: RegistryEntry[],
	opts: {
		sessionId: string;
		vaultCwd: string;
		isAlive: (pid: number) => boolean;
		isOwn: (pid: number) => boolean;
	}
): ExternalActivity {
	const cwd = normalizeCwd(opts.vaultCwd);
	let best: ExternalActivity = { severity: "none" };
	for (const e of entries) {
		if (e.sessionId !== opts.sessionId) continue;
		if (normalizeCwd(e.cwd) !== cwd) continue;
		if (!opts.isAlive(e.pid)) continue;
		if (opts.isOwn(e.pid)) continue;
		// Headless (`sdk-cli`) and foreign SDK (`sdk-ts`) entries only exist while
		// actively running; an interactive `cli` reports busy/idle explicitly.
		const busy = e.status === "busy" || e.entrypoint === "sdk-cli" || e.entrypoint === "sdk-ts";
		if (busy) return { severity: "busy", pid: e.pid, entrypoint: e.entrypoint };
		if (best.severity === "none") best = { severity: "idle", pid: e.pid, entrypoint: e.entrypoint };
	}
	return best;
}
