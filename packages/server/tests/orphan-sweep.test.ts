import { isAgentSubprocessCmdline, sweepOrphanedAgents, type SweepDeps } from "../src/orphan-sweep";

const SDK_CMD =
	"/home/u/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json --verbose " +
	"--input-format stream-json --model claude-opus-4-8 --permission-prompt-tool stdio --resume abc --permission-mode default";

describe("isAgentSubprocessCmdline", () => {
	it("matches an SDK-spawned streaming child", () => {
		expect(isAgentSubprocessCmdline(SDK_CMD)).toBe(true);
	});
	it("does NOT match an interactive CLI (no streaming-input flag)", () => {
		expect(isAgentSubprocessCmdline("/home/u/.local/bin/claude")).toBe(false);
		expect(isAgentSubprocessCmdline("/home/u/.local/bin/claude --resume abc")).toBe(false);
	});
	it("does NOT match unrelated processes", () => {
		expect(isAgentSubprocessCmdline("node /srv/app/index.js --input-format stream-json")).toBe(false); // not the SDK binary
		expect(isAgentSubprocessCmdline("/usr/bin/vim notes.md")).toBe(false);
	});
});

/** Build sweep deps over in-memory process tables. */
function deps(
	over: {
		ownPid?: number;
		procs: Record<number, { cmdline: string; ppid: number }>;
		killable?: (pid: number) => boolean;
	}
): { d: SweepDeps; killed: number[] } {
	const killed: number[] = [];
	const d: SweepDeps = {
		ownPid: over.ownPid ?? 1000,
		listPids: () => Object.keys(over.procs).map(Number),
		cmdline: (pid) => over.procs[pid]?.cmdline,
		parentOf: (pid) => over.procs[pid]?.ppid,
		kill: (pid) => {
			if (over.killable && !over.killable(pid)) return false;
			killed.push(pid);
			return true;
		},
	};
	return { d, killed };
}

describe("sweepOrphanedAgents", () => {
	it("sweeps an orphaned SDK child (reparented to init)", () => {
		const { d, killed } = deps({ procs: { 42: { cmdline: SDK_CMD, ppid: 1 } } });
		expect(sweepOrphanedAgents(d)).toEqual([42]);
		expect(killed).toEqual([42]);
	});

	it("never sweeps our own live descendants", () => {
		// 55 is an SDK child whose parent chain leads to ownPid (1000) → a live session.
		const { d, killed } = deps({
			ownPid: 1000,
			procs: {
				55: { cmdline: SDK_CMD, ppid: 1000 },
				56: { cmdline: SDK_CMD, ppid: 55 }, // grandchild, still ours
			},
		});
		expect(sweepOrphanedAgents(d)).toEqual([]);
		expect(killed).toEqual([]);
	});

	it("skips non-SDK processes and our own pid", () => {
		const { d, killed } = deps({
			ownPid: 1000,
			procs: {
				1000: { cmdline: "node index.js", ppid: 1 }, // us
				7: { cmdline: "/usr/bin/vim", ppid: 1 }, // unrelated
				8: { cmdline: "/home/u/.local/bin/claude --resume x", ppid: 1 }, // interactive CLI
			},
		});
		expect(sweepOrphanedAgents(d)).toEqual([]);
		expect(killed).toEqual([]);
	});

	it("counts only pids the kill actually reached (race: process already gone)", () => {
		const { d, killed } = deps({
			procs: { 42: { cmdline: SDK_CMD, ppid: 1 }, 43: { cmdline: SDK_CMD, ppid: 1 } },
			killable: (pid) => pid !== 43, // 43 vanished between listing and kill
		});
		expect(sweepOrphanedAgents(d)).toEqual([42]);
		expect(killed).toEqual([42]);
	});
});
