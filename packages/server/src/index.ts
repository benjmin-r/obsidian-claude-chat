/**
 * Entry point: load config, build the SessionManager with the real SDK adapter,
 * and start the WebSocket transport bound to the Tailscale IP.
 */

import { loadConfig } from "./config";
import {
	deleteStored,
	detectExternalActivity,
	listStored,
	loadHistory,
	renameStored,
	runQuery,
	sweepOrphanedAgentsFromProc,
} from "./sdk-adapter";
import { SessionManager } from "./session-manager";
import { startTransport } from "./ws-transport";

function main(): void {
	const config = loadConfig();

	// Reclaim any Agent-SDK subprocesses orphaned by a previous run (a hard crash skips
	// node's exit-time teardown; KillMode=process leaves them behind). We have no children
	// yet, so every match is a genuine orphan.
	const swept = sweepOrphanedAgentsFromProc();
	if (swept.length > 0) {
		// eslint-disable-next-line no-console
		console.log(`[occ] swept ${swept.length} orphaned agent subprocess(es) from a previous run: [${swept.join(",")}]`);
	}

	let counter = 0;
	const manager = new SessionManager(
		{
			runQuery,
			now: () => Date.now(),
			newHandleId: () => `new-${Date.now()}-${(counter += 1)}`,
			listStored,
			loadHistory,
			renameStored,
			deleteStored,
			detectExternalActivity,
		},
		{ cwd: config.vaultCwd, defaultModel: config.defaultModel, bufferLimit: config.bufferLimit }
	);

	const transport = startTransport(config, manager);

	// NOTE: CLI activity is checked on demand only — when a session is opened/reloaded
	// (resumeWithHistory) and before each send (sendGate). There is intentionally NO
	// periodic poll: read-only never clears or reloads on its own; the user reloads.

	// Release idle, detached sessions after 5 min so we stop being a writer the
	// user's own CLI would conflict with (and free the subprocess). A detached
	// session stuck awaiting a permission decision keeps its subprocess pinned, so
	// auto-deny abandoned prompts after 1 h (a real deny, not the phantom-reject a
	// bare drop would cause) and let the ensuing idle state reap it.
	const reaper = setInterval(() => manager.reapIdle(5 * 60_000, 60 * 60_000), 60_000);
	reaper.unref();

	// eslint-disable-next-line no-console
	console.log(`[occ] listening on ws://${config.host}:${config.port} (cwd=${config.vaultCwd}, model=${config.defaultModel})`);

	const shutdown = (): void => {
		void transport.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
