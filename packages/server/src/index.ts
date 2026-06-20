/**
 * Entry point: load config, build the SessionManager with the real SDK adapter,
 * and start the WebSocket transport bound to the Tailscale IP.
 */

import { loadConfig } from "./config";
import { listStored, loadHistory, renameStored, runQuery } from "./sdk-adapter";
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
		},
		{ cwd: config.vaultCwd, defaultModel: config.defaultModel, bufferLimit: config.bufferLimit }
	);

	const transport = startTransport(config, manager);

	// eslint-disable-next-line no-console
	console.log(`[occ] listening on ws://${config.host}:${config.port} (cwd=${config.vaultCwd}, model=${config.defaultModel})`);

	const shutdown = (): void => {
		void transport.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
