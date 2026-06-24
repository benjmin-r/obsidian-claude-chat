import { type App, prepareFuzzySearch, setIcon, type TFile } from "obsidian";

/** Max files shown in the dropdown at once. */
const MAX_RESULTS = 8;

/** A detected `@mention` being typed: where the `@` is and the text after it. */
export interface MentionQuery {
	/** Index of the `@` in the buffer. */
	start: number;
	/** Text between the `@` and the caret (may be empty right after typing `@`). */
	query: string;
}

/**
 * Detect an `@token` ending exactly at `caret`, with no whitespace between the
 * `@` and the caret. The `@` must start the buffer or follow whitespace, so
 * emails (`a@b`) and mid-word `@`s don't trigger a mention. Pure + unit-tested.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
	for (let i = caret - 1; i >= 0; i--) {
		const ch = text[i]!;
		if (ch === "@") {
			const prev = i > 0 ? text[i - 1]! : "";
			if (prev === "" || /\s/.test(prev)) return { start: i, query: text.slice(i + 1, caret) };
			return null;
		}
		if (/\s/.test(ch)) return null; // hit whitespace before any `@`
	}
	return null;
}

/**
 * Replace the `@query` spanning `[start, caret)` with `@path ` (trailing space so
 * the next keystroke starts a fresh word). Returns the new buffer and caret. Pure.
 */
export function spliceMention(
	text: string,
	start: number,
	caret: number,
	path: string
): { text: string; caret: number } {
	const before = text.slice(0, start) + `@${path} `;
	return { text: before + text.slice(caret), caret: before.length };
}

/**
 * Self-contained `@`-mention file picker over a plain `<textarea>` (Obsidian's
 * `AbstractInputSuggest` only supports `<input>`/contenteditable). Anchored above
 * the composer via CSS; the controller owns querying, navigation, and insertion.
 */
export class FileSuggest {
	private readonly el: HTMLElement;
	private items: TFile[] = [];
	private active = 0;
	private opened = false;
	private mention: MentionQuery | null = null;
	private blurTimer: number | undefined;

	constructor(
		private readonly app: App,
		private readonly input: HTMLTextAreaElement,
		container: HTMLElement
	) {
		this.el = container.createDiv({ cls: "occ-file-suggest" });
		this.el.style.display = "none";
		this.input.addEventListener("input", () => this.onInput());
		// Close shortly after blur, but late enough that an item mousedown lands first.
		this.input.addEventListener("blur", () => {
			this.blurTimer = window.setTimeout(() => this.close(), 120);
		});
	}

	isOpen(): boolean {
		return this.opened;
	}

	close(): void {
		if (this.blurTimer !== undefined) {
			window.clearTimeout(this.blurTimer);
			this.blurTimer = undefined;
		}
		if (!this.opened) return;
		this.opened = false;
		this.mention = null;
		this.el.style.display = "none";
		this.el.empty();
	}

	/** Consume nav/accept keys while open. Escape is handled by the view root. */
	handleKeydown(e: KeyboardEvent): boolean {
		if (!this.opened) return false;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				this.move(1);
				return true;
			case "ArrowUp":
				e.preventDefault();
				this.move(-1);
				return true;
			case "Enter":
			case "Tab":
				e.preventDefault();
				this.accept();
				return true;
			default:
				return false;
		}
	}

	private onInput(): void {
		const caret = this.input.selectionStart ?? this.input.value.length;
		const m = findMentionQuery(this.input.value, caret);
		if (!m) {
			this.close();
			return;
		}
		this.items = this.search(m.query);
		if (this.items.length === 0) {
			this.close();
			return;
		}
		this.mention = m;
		this.active = 0;
		this.opened = true;
		this.render();
	}

	private search(query: string): TFile[] {
		const files = this.app.vault.getFiles();
		if (!query) return files.slice(0, MAX_RESULTS);
		const matcher = prepareFuzzySearch(query);
		const scored: Array<{ file: TFile; score: number }> = [];
		for (const file of files) {
			const result = matcher(file.path);
			if (result) scored.push({ file, score: result.score });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, MAX_RESULTS).map((s) => s.file);
	}

	private move(delta: number): void {
		const n = this.items.length;
		this.active = (this.active + delta + n) % n;
		this.render();
	}

	private accept(): void {
		const file = this.items[this.active];
		if (!file || !this.mention) {
			this.close();
			return;
		}
		const caret = this.input.selectionStart ?? this.input.value.length;
		const spliced = spliceMention(this.input.value, this.mention.start, caret, file.path);
		this.input.value = spliced.text;
		this.input.setSelectionRange(spliced.caret, spliced.caret);
		this.close();
		this.input.focus();
		// Persist the draft + let any other input listeners react to the inserted path.
		this.input.dispatchEvent(new Event("input"));
	}

	private render(): void {
		this.el.empty();
		this.items.forEach((file, idx) => {
			const row = this.el.createDiv({ cls: "occ-file-suggest-item" });
			if (idx === this.active) row.addClass("is-active");
			setIcon(row.createSpan({ cls: "occ-file-suggest-icon" }), "file");
			const text = row.createDiv({ cls: "occ-file-suggest-text" });
			text.createSpan({ cls: "occ-file-suggest-name", text: file.basename || file.name });
			if (file.parent && file.parent.path && file.parent.path !== "/") {
				text.createSpan({ cls: "occ-file-suggest-path", text: file.parent.path });
			}
			// mousedown (not click) so it fires before the textarea blur; preventDefault
			// keeps focus in the composer.
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.active = idx;
				this.accept();
			});
		});
		this.el.style.display = "";
	}
}
