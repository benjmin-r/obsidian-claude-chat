import {
	classifyHolders,
	isDescendant,
	normalizeCwd,
	parseEntry,
	type RegistryEntry,
} from "../src/external-activity";

const VAULT = "/home/benjamin/vaults/benjamin";

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
	return { pid: 100, sessionId: "S", cwd: VAULT, entrypoint: "cli", status: "idle", ...over };
}

const aliveAll = () => true;
const ownNone = () => false;

describe("normalizeCwd", () => {
	it("strips trailing slashes", () => {
		expect(normalizeCwd(`${VAULT}/`)).toBe(VAULT);
		expect(normalizeCwd(VAULT)).toBe(VAULT);
	});
});

describe("parseEntry", () => {
	it("parses a well-formed entry", () => {
		const e = parseEntry(JSON.stringify(entry({ pid: 7, status: "busy" })));
		expect(e).toMatchObject({ pid: 7, sessionId: "S", cwd: VAULT, entrypoint: "cli", status: "busy" });
	});
	it("returns null for malformed JSON or missing required fields", () => {
		expect(parseEntry("not json")).toBeNull();
		expect(parseEntry(JSON.stringify({ sessionId: "S", cwd: VAULT }))).toBeNull(); // no pid
		expect(parseEntry(JSON.stringify({ pid: 1, cwd: VAULT }))).toBeNull(); // no sessionId
	});
});

describe("isDescendant", () => {
	// tree: 500 (server) -> 600 -> 610 ;  900 is unrelated (parent 1)
	const parents: Record<number, number> = { 600: 500, 610: 600, 900: 1, 500: 1 };
	const parentOf = (p: number) => parents[p];
	it("matches the ancestor itself and descendants", () => {
		expect(isDescendant(500, 500, parentOf)).toBe(true);
		expect(isDescendant(600, 500, parentOf)).toBe(true);
		expect(isDescendant(610, 500, parentOf)).toBe(true);
	});
	it("rejects unrelated processes", () => {
		expect(isDescendant(900, 500, parentOf)).toBe(false);
	});
	it("terminates on cycles / missing parents", () => {
		expect(isDescendant(42, 500, () => 42)).toBe(false); // self-cycle, never reaches 500
	});
});

describe("classifyHolders", () => {
	const opts = { sessionId: "S", vaultCwd: VAULT, isAlive: aliveAll, isOwn: ownNone };

	it("none when no entries match", () => {
		expect(classifyHolders([], opts).severity).toBe("none");
		expect(classifyHolders([entry({ sessionId: "OTHER" })], opts).severity).toBe("none");
	});

	it("ignores entries from a different working dir", () => {
		expect(classifyHolders([entry({ cwd: "/home/benjamin/projects" })], opts).severity).toBe("none");
	});

	it("idle for a parked interactive cli", () => {
		const r = classifyHolders([entry({ pid: 42, status: "idle" })], opts);
		expect(r).toMatchObject({ severity: "idle", pid: 42, entrypoint: "cli" });
	});

	it("busy for a cli mid-turn", () => {
		expect(classifyHolders([entry({ status: "busy" })], opts).severity).toBe("busy");
	});

	it("busy for a live headless/SDK process regardless of status", () => {
		expect(classifyHolders([entry({ entrypoint: "sdk-cli", status: undefined })], opts).severity).toBe("busy");
		expect(classifyHolders([entry({ entrypoint: "sdk-ts", status: undefined })], opts).severity).toBe("busy");
	});

	it("busy wins over idle when multiple holders exist", () => {
		const r = classifyHolders([entry({ pid: 1, status: "idle" }), entry({ pid: 2, status: "busy" })], opts);
		expect(r.severity).toBe("busy");
	});

	it("skips dead pids", () => {
		const isAlive = (pid: number) => pid !== 42;
		expect(classifyHolders([entry({ pid: 42, status: "busy" })], { ...opts, isAlive }).severity).toBe("none");
	});

	it("excludes our own subprocesses (isOwn)", () => {
		const isOwn = (pid: number) => pid === 100;
		expect(classifyHolders([entry({ pid: 100, status: "busy" })], { ...opts, isOwn }).severity).toBe("none");
	});

	it("tolerates a trailing slash on either cwd", () => {
		expect(classifyHolders([entry({ cwd: `${VAULT}/` })], opts).severity).toBe("idle");
		expect(classifyHolders([entry()], { ...opts, vaultCwd: `${VAULT}/` }).severity).toBe("idle");
	});
});
