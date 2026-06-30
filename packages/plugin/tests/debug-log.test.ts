import { DebugLog, type DebugLogStore } from "../src/debug-log";

/** Map-backed fake of the Web Storage subset. */
function fakeStore(): DebugLogStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	};
}

const fixedNow = () => 1_700_000_000_000; // deterministic timestamps

describe("DebugLog", () => {
	it("appends tagged, timestamped lines", () => {
		const log = new DebugLog({ now: fixedNow });
		log.log("ws", "open");
		expect(log.count()).toBe(1);
		expect(log.tail(1)[0]).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d \[ws\] open$/);
	});

	it("enforces the ring-buffer limit", () => {
		const log = new DebugLog({ now: fixedNow, limit: 3 });
		for (let i = 0; i < 5; i++) log.log("ws", `m${i}`);
		expect(log.count()).toBe(3);
		expect(log.tail(3).map((l) => l.split("] ")[1])).toEqual(["m2", "m3", "m4"]);
	});

	it("numbers markers and includes an optional label", () => {
		const log = new DebugLog({ now: fixedNow });
		expect(log.marker()).toBe(1);
		expect(log.marker("foreground")).toBe(2);
		expect(log.markerCount()).toBe(2);
		expect(log.tail(1)[0]).toContain("MARKER 2 — foreground");
	});

	it("persists lines + marker count across instances (survives view recreate)", () => {
		const store = fakeStore();
		const a = new DebugLog({ now: fixedNow, store });
		a.log("ws", "line1");
		a.marker();
		const b = new DebugLog({ now: fixedNow, store }); // simulate teardown → reopen
		expect(b.count()).toBe(2);
		expect(b.tail(2)[0]).toContain("line1");
		expect(b.marker()).toBe(2); // continues numbering, no duplicate "MARKER 1"
	});

	it("clear() empties memory and storage", () => {
		const store = fakeStore();
		const log = new DebugLog({ now: fixedNow, store });
		log.log("ws", "x");
		log.clear();
		expect(log.count()).toBe(0);
		expect(store.map.size).toBe(0);
		expect(log.marker()).toBe(1);
	});

	it("static purge() removes the persisted log without an instance", () => {
		const store = fakeStore();
		new DebugLog({ now: fixedNow, store }).log("ws", "x");
		expect(store.map.size).toBe(1);
		DebugLog.purge(store);
		expect(store.map.size).toBe(0);
	});

	it("tolerates a corrupt storage payload", () => {
		const store = fakeStore();
		store.map.set("occ-debug-log", "{not json");
		const log = new DebugLog({ now: fixedNow, store });
		expect(log.count()).toBe(0);
	});

	it("fires onChange on append and clear", () => {
		const onChange = jest.fn();
		const log = new DebugLog({ now: fixedNow, onChange });
		log.log("ws", "a");
		log.marker();
		log.clear();
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("report() includes a header with counts", () => {
		const log = new DebugLog({ now: fixedNow });
		log.log("ws", "a");
		log.marker();
		expect(log.report()).toMatch(/^=== OCC connection debug \(2 lines, 1 markers\) ===/);
	});
});
