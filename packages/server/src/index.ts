/**
 * Entry point: load config, build the SessionManager with the real SDK adapter,
 * and start the WebSocket transport bound to the Tailscale IP.
 */

import { loadConfig } from "./config";
import { deleteStored, detectExternalActivity, listStored, loadHistory, renameStored, runQuery } from "./sdk-adapter";
import { SessionManager } from "./session-manager";
import { startTransport } from "./ws-transport";

function main(): void {
	const config = loadConfig();

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

	// Proactively surface CLI activity (read-only) to attached clients. Lightweight
	// (a small registry read per loaded session), so we poll snappily.
	const poll = setInterval(() => manager.pollExternalActivity(), 1500);
	poll.unref();

	// Release idle, detached sessions after 5 min so we stop being a writer the
	// user's own CLI would conflict with (and free the subprocess).
	const reaper = setInterval(() => manager.reapIdle(5 * 60_000), 60_000);
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
