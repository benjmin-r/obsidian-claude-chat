import { App, TFile } from "obsidian";
import { FileSuggest, findMentionQuery, spliceMention } from "../src/file-suggest";

describe("findMentionQuery", () => {
	it("detects a bare @ at the caret with an empty query", () => {
		expect(findMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
	});

	it("detects an @token at the caret", () => {
		expect(findMentionQuery("see @Not", 8)).toEqual({ start: 4, query: "Not" });
	});

	it("keeps path characters inside the query", () => {
		expect(findMentionQuery("@folder/sub/file", 16)).toEqual({ start: 0, query: "folder/sub/file" });
	});

	it("requires the @ to start the buffer or follow whitespace (ignores emails)", () => {
		expect(findMentionQuery("a@b", 3)).toBeNull();
		expect(findMentionQuery("mail me@x", 9)).toBeNull();
	});

	it("returns null when whitespace sits between the @ and the caret", () => {
		expect(findMentionQuery("@foo bar", 8)).toBeNull();
	});

	it("returns null when there is no @ before the caret", () => {
		expect(findMentionQuery("plain text", 5)).toBeNull();
	});

	it("uses the caret, not the end of the buffer", () => {
		// caret sits right after "@No"; the trailing "te x" is ignored.
		expect(findMentionQuery("@Note x", 3)).toEqual({ start: 0, query: "No" });
	});
});

describe("spliceMention", () => {
	it("replaces the @query with @path and a trailing space", () => {
		const r = spliceMention("@No", 0, 3, "Daily/Note.md");
		expect(r.text).toBe("@Daily/Note.md ");
		expect(r.caret).toBe(r.text.length);
	});

	it("preserves text on both sides of the mention", () => {
		const r = spliceMention("read @al please", 5, 8, "Projects/Alpha.md");
		expect(r.text).toBe("read @Projects/Alpha.md  please");
		// caret lands right after the inserted path's trailing space.
		expect(r.text.slice(0, r.caret)).toBe("read @Projects/Alpha.md ");
	});
});

describe("FileSuggest", () => {
	let app: App;
	let input: HTMLTextAreaElement;
	let container: HTMLElement;
	let suggest: FileSuggest;

	const files = ["Daily/Note.md", "notes.md", "Projects/Alpha.md"].map((p) => new TFile(p));

	function type(value: string, caret = value.length): void {
		input.value = value;
		input.setSelectionRange(caret, caret);
		input.dispatchEvent(new Event("input"));
	}

	function items(): HTMLElement[] {
		return Array.from(container.querySelectorAll(".occ-file-suggest-item"));
	}

	beforeEach(() => {
		app = new App();
		app.vault.getFiles = () => files as unknown as ReturnType<typeof app.vault.getFiles>;
		container = document.createElement("div");
		document.body.appendChild(container);
		input = document.createElement("textarea");
		container.appendChild(input);
		suggest = new FileSuggest(app, input, container);
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("opens with fuzzy matches when typing an @mention", () => {
		type("@no");
		expect(suggest.isOpen()).toBe(true);
		// "no" matches Daily/Note.md and notes.md, not Projects/Alpha.md.
		expect(items()).toHaveLength(2);
		expect(items()[0]!.classList.contains("is-active")).toBe(true);
	});

	it("shows all files (capped) for a bare @", () => {
		type("@");
		expect(suggest.isOpen()).toBe(true);
		expect(items()).toHaveLength(3);
	});

	it("closes when the query matches nothing", () => {
		type("@zzzzz");
		expect(suggest.isOpen()).toBe(false);
		expect(items()).toHaveLength(0);
	});

	it("closes when the mention is no longer being typed", () => {
		type("@no");
		expect(suggest.isOpen()).toBe(true);
		type("@no done");
		expect(suggest.isOpen()).toBe(false);
	});

	it("ignores nav keys when closed", () => {
		const e = new KeyboardEvent("keydown", { key: "ArrowDown" });
		expect(suggest.handleKeydown(e)).toBe(false);
	});

	it("navigates with ArrowDown/ArrowUp and wraps around", () => {
		type("@");
		const down = new KeyboardEvent("keydown", { key: "ArrowDown" });
		suggest.handleKeydown(down);
		expect(items()[1]!.classList.contains("is-active")).toBe(true);
		// Wrap from the top back to the last item.
		const up = new KeyboardEvent("keydown", { key: "ArrowUp" });
		suggest.handleKeydown(up); // -> index 0
		suggest.handleKeydown(up); // wrap -> last
		expect(items()[items().length - 1]!.classList.contains("is-active")).toBe(true);
	});

	it("accepts the active item with Enter and inserts @path ", () => {
		type("@no");
		const enter = new KeyboardEvent("keydown", { key: "Enter" });
		expect(suggest.handleKeydown(enter)).toBe(true);
		expect(input.value).toBe("@Daily/Note.md ");
		expect(suggest.isOpen()).toBe(false);
	});

	it("accepts with Tab on the navigated item", () => {
		type("@no");
		suggest.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
		suggest.handleKeydown(new KeyboardEvent("keydown", { key: "Tab" }));
		expect(input.value).toBe("@notes.md ");
	});

	it("accepts on item mousedown", () => {
		type("@no");
		items()[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		expect(input.value).toBe("@notes.md ");
		expect(suggest.isOpen()).toBe(false);
	});

	it("inserts the mention mid-buffer without disturbing the rest", () => {
		type("ping @al here", 8); // caret right after "@al"
		const enter = new KeyboardEvent("keydown", { key: "Enter" });
		suggest.handleKeydown(enter);
		expect(input.value).toBe("ping @Projects/Alpha.md  here");
	});

	it("does not consume keys it doesn't handle", () => {
		type("@no");
		expect(suggest.handleKeydown(new KeyboardEvent("keydown", { key: "a" }))).toBe(false);
	});

	it("close() is idempotent and hides the dropdown", () => {
		type("@no");
		suggest.close();
		suggest.close();
		expect(suggest.isOpen()).toBe(false);
		const el = container.querySelector(".occ-file-suggest") as HTMLElement;
		expect(el.style.display).toBe("none");
	});
});
