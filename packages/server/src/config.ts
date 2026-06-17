/**
 * Server configuration, loaded from the environment. Pure (takes an `env`
 * argument) so it is unit-testable.
 *
 * SECURITY: we intentionally bind to the Tailscale IP, never `0.0.0.0`, and we
 * intentionally do NOT read `ANTHROPIC_API_KEY` here — the service must run on
 * the Claude subscription (an API key in the env would silently switch the SDK
 * to metered API billing). The systemd unit must not set it.
 */

export interface ServerConfig {
	/** App-level bearer token validated on `hello`. */
	token: string;
	/** Bind address — the host's Tailscale IP. Never 0.0.0.0 / :: . */
	host: string;
	port: number;
	/** Canonical vault path; MUST match the CLI store path for resume/interop. */
	vaultCwd: string;
	defaultModel: string;
	bufferLimit: number;
}

export const DEFAULT_PORT = 8765;
export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_VAULT_CWD = "/home/USER/vaults/VAULT";
export const DEFAULT_BUFFER_LIMIT = 2000;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const token = (env.OCC_TOKEN ?? "").trim();
	if (!token) {
		throw new ConfigError("OCC_TOKEN is required (the bearer token clients present on hello).");
	}

	const host = (env.OCC_HOST ?? "").trim();
	if (!host) {
		throw new ConfigError("OCC_HOST is required (bind to the server's Tailscale IP, never 0.0.0.0).");
	}
	if (host === "0.0.0.0" || host === "::" || host === "*") {
		throw new ConfigError(`Refusing to bind to ${host}: bind to the Tailscale IP only.`);
	}

	const port = parsePort(env.OCC_PORT) ?? DEFAULT_PORT;
	const vaultCwd = (env.OCC_VAULT_CWD ?? DEFAULT_VAULT_CWD).trim();
	const defaultModel = (env.OCC_MODEL ?? DEFAULT_MODEL).trim();
	const bufferLimit = parsePort(env.OCC_BUFFER_LIMIT) ?? DEFAULT_BUFFER_LIMIT;

	return { token, host, port, vaultCwd, defaultModel, bufferLimit };
}

function parsePort(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) {
		throw new ConfigError(`Invalid numeric value: ${raw}`);
	}
	return n;
}
