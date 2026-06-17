import { ConfigError, DEFAULT_MODEL, DEFAULT_PORT, loadConfig } from "../src/config";

describe("loadConfig", () => {
	const base = { OCC_TOKEN: "secret", OCC_HOST: "100.64.0.1" };

	it("loads with defaults", () => {
		const c = loadConfig(base);
		expect(c).toMatchObject({ token: "secret", host: "100.64.0.1", port: DEFAULT_PORT, defaultModel: DEFAULT_MODEL });
	});

	it("requires a token", () => {
		expect(() => loadConfig({ OCC_HOST: "100.0.0.1" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, OCC_TOKEN: "  " })).toThrow(/OCC_TOKEN/);
	});

	it("requires a host and refuses wildcard binds", () => {
		expect(() => loadConfig({ OCC_TOKEN: "x" })).toThrow(/OCC_HOST/);
		expect(() => loadConfig({ OCC_TOKEN: "x", OCC_HOST: "0.0.0.0" })).toThrow(/Tailscale/);
		expect(() => loadConfig({ OCC_TOKEN: "x", OCC_HOST: "::" })).toThrow(/Tailscale/);
	});

	it("overrides port, model, cwd", () => {
		const c = loadConfig({ ...base, OCC_PORT: "9000", OCC_MODEL: "claude-sonnet-4-6", OCC_VAULT_CWD: "/v" });
		expect(c).toMatchObject({ port: 9000, defaultModel: "claude-sonnet-4-6", vaultCwd: "/v" });
	});

	it("rejects invalid ports", () => {
		expect(() => loadConfig({ ...base, OCC_PORT: "0" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, OCC_PORT: "99999" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, OCC_PORT: "abc" })).toThrow(ConfigError);
	});
});
