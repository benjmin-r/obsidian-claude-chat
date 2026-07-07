/**
 * Startup orphan sweep — kill Agent-SDK subprocesses left behind by a previous
 * server run.
 *
 * The systemd unit uses `KillMode=process`, so on a CLEAN stop node's own
 * `process.on("exit")` hook SIGTERMs the SDK children — but a HARD crash (SIGKILL,
 * OOM) skips that hook and orphans them. They pin ~165 MB each until the box is
 * rebooted (see the RAM-exhaustion incident). This sweep, run ONCE at startup
 * before any session spawns, reclaims them.
 *
 * Pure over injected deps (no `fs`/`process` here) so the selection + safety logic
 * is unit-tested; `sdk-adapter.ts` supplies the real `/proc` + `process.kill`.
 */

import { isDescendant } from "./external-activity";

/**
 * True for an SDK-spawned streaming CLI child. Matches the vendored binary path
 * plus the streaming-input flag the SDK always passes — which an interactive
 * `claude` in a terminal does NOT — so we never sweep a user's own CLI session.
 */
export function isAgentSubprocessCmdline(cmdline: string): boolean {
	return cmdline.includes("claude-agent-sdk") && cmdline.includes("--input-format stream-json");
}

export interface SweepDeps {
	/** this server's pid — never swept, and its live descendants are skipped. */
	ownPid: number;
	/** candidate pids to inspect (e.g. numeric entries under /proc). */
	listPids(): number[];
	/** a pid's full command line (argv joined by spaces), or undefined if gone/unreadable. */
	cmdline(pid: number): string | undefined;
	/** a pid's parent pid, or undefined if unavailable. */
	parentOf(pid: number): number | undefined;
	/** signal the pid; return true if the signal was delivered. */
	kill(pid: number): boolean;
}

/**
 * Select and signal orphaned Agent-SDK subprocesses. Skips our own pid and our own
 * live descendants (so it's safe even if ever called after sessions start, though it
 * is meant for startup when we have no children yet). Returns the pids swept.
 */
export function sweepOrphanedAgents(deps: SweepDeps): number[] {
	const swept: number[] = [];
	for (const pid of deps.listPids()) {
		if (pid === deps.ownPid) continue;
		const cmdline = deps.cmdline(pid);
		if (!cmdline || !isAgentSubprocessCmdline(cmdline)) continue;
		if (isDescendant(pid, deps.ownPid, deps.parentOf)) continue; // our own live child — never kill
		if (deps.kill(pid)) swept.push(pid);
	}
	return swept;
}
