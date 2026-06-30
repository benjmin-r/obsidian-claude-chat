/**
 * Ring-buffer debug logger for the connection-debug panel. Pure logic with an
 * injected clock + storage, so it is unit-testable with no DOM. Persists to
 * localStorage so the log survives the view teardown/recreate that iPad
 * backgrounding causes — which is exactly when the connection bugs we want to
 * capture happen, so an in-memory-only log would lose the transition.
 */

/** Minimal subset of the Web Storage API (so tests can pass a fake). */
export interface DebugLogStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface DebugLogOptions {
	/** injected clock (testability); defaults to Date.now. */
	now?: () => number;
	/** persistence backend; omit for in-memory only. */
	store?: DebugLogStore;
	storageKey?: string;
	/** max retained lines (ring buffer). */
	limit?: number;
	/** called after every append/clear so a panel can re-render. */
	onChange?: () => void;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_KEY = "occ-debug-log";

function pad(n: number, w = 2): string {
	return n.toString().padStart(w, "0");
}

/** Wall-clock HH:MM:SS.mmm — short but precise enough to line up with reported timings. */
function clockStr(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

interface Persisted {
	lines: string[];
	markers: number;
}

export class DebugLog {
	private lines: string[] = [];
	private markers = 0;
	private readonly limit: number;
	private readonly key: string;

	constructor(private readonly opts: DebugLogOptions = {}) {
		this.limit = opts.limit ?? DEFAULT_LIMIT;
		this.key = opts.storageKey ?? DEFAULT_KEY;
		this.load();
	}

	/**
	 * Remove a persisted log without constructing an instance — used to clean up
	 * stale logs when the debug panel is disabled (the logger is never created then,
	 * so it can't clear after itself).
	 */
	static purge(store: DebugLogStore, storageKey = DEFAULT_KEY): void {
		try {
			store.removeItem(storageKey);
		} catch {
			// ignore
		}
	}

	private nowMs(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	private load(): void {
		const raw = this.opts.store?.getItem(this.key);
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as Partial<Persisted>;
			if (Array.isArray(parsed.lines)) this.lines = parsed.lines.slice(-this.limit).map(String);
			if (typeof parsed.markers === "number") this.markers = parsed.markers;
		} catch {
			// corrupt cache — start fresh
		}
	}

	private persist(): void {
		const data: Persisted = { lines: this.lines, markers: this.markers };
		try {
			this.opts.store?.setItem(this.key, JSON.stringify(data));
		} catch {
			// storage full/unavailable — keep going in-memory
		}
	}

	private push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.limit) this.lines = this.lines.slice(-this.limit);
		this.persist();
		this.opts.onChange?.();
	}

	/** Append a tagged, timestamped line. */
	log(tag: string, msg: string): void {
		this.push(`${clockStr(this.nowMs())} [${tag}] ${msg}`);
	}

	/** Insert a numbered section marker; returns the (1-based) marker number. */
	marker(label?: string): number {
		this.markers += 1;
		const n = this.markers;
		const text = label ? `MARKER ${n} — ${label}` : `MARKER ${n}`;
		this.push(`${clockStr(this.nowMs())} ===== ${text} =====`);
		return n;
	}

	clear(): void {
		this.lines = [];
		this.markers = 0;
		try {
			this.opts.store?.removeItem(this.key);
		} catch {
			// ignore
		}
		this.opts.onChange?.();
	}

	count(): number {
		return this.lines.length;
	}

	markerCount(): number {
		return this.markers;
	}

	/** Most-recent `n` lines (for the live panel tail). */
	tail(n: number): string[] {
		return this.lines.slice(-n);
	}

	/** Full report for the clipboard. */
	report(): string {
		return [`=== OCC connection debug (${this.lines.length} lines, ${this.markers} markers) ===`, ...this.lines].join("\n");
	}
}
