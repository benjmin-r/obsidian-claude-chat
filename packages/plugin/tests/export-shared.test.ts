import {
	escapeHtml,
	exportFilePath,
	sanitizeFilename,
	summarizeExportItem,
	truncateInline,
	truncateToolOutput,
} from "../src/export-shared";
import type { ActivityItem } from "../src/view-model";

describe("sanitizeFilename", () => {
	it("strips filesystem-illegal characters", () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
	});
	it("collapses whitespace and trims", () => {
		expect(sanitizeFilename("  My   Chat   Session  ")).toBe("My Chat Session");
	});
	it("caps length to ~80 chars", () => {
		const long = "x".repeat(200);
		expect(sanitizeFilename(long).length).toBeLessThanOrEqual(80);
	});
	it("falls back to 'Untitled session' when empty after cleanup", () => {
		expect(sanitizeFilename("   ")).toBe("Untitled session");
		expect(sanitizeFilename("///???")).toBe("Untitled session");
	});
});

describe("exportFilePath", () => {
	const updatedAt = Date.parse("2026-08-18T08:41:01.332Z");

	it("builds a date-led path without month grouping", () => {
		expect(exportFilePath("Claude Conversations", false, "My Chat", updatedAt, "md")).toBe(
			"Claude Conversations/20260818 - My Chat.md"
		);
	});
	it("groups by YYYY-MM when requested", () => {
		expect(exportFilePath("Claude Conversations", true, "My Chat", updatedAt, "html")).toBe(
			"Claude Conversations/2026-08/20260818 - My Chat.html"
		);
	});
	it("is deterministic for the same inputs", () => {
		const a = exportFilePath("base", true, "Title", updatedAt, "md");
		const b = exportFilePath("base", true, "Title", updatedAt, "md");
		expect(a).toBe(b);
	});
	it("falls back to 'now' when updatedAt is absent, still producing a valid path", () => {
		const path = exportFilePath("base", false, "Title", undefined, "md");
		expect(path).toMatch(/^base\/\d{8} - Title\.md$/);
	});
	it("appends a numeric disambiguator suffix when given", () => {
		expect(exportFilePath("base", false, "Title", updatedAt, "md", 2)).toBe("base/20260818 - Title (2).md");
		expect(exportFilePath("base", false, "Title", updatedAt, "md", 3)).toBe("base/20260818 - Title (3).md");
	});
	it("omits the suffix for suffix 1 or undefined", () => {
		expect(exportFilePath("base", false, "Title", updatedAt, "md", 1)).toBe("base/20260818 - Title.md");
		expect(exportFilePath("base", false, "Title", updatedAt, "md")).toBe("base/20260818 - Title.md");
	});
	it("sanitizes the title within the path", () => {
		expect(exportFilePath("base", false, 'a/b:c"d', updatedAt, "md")).toBe("base/20260818 - abcd.md");
	});
});

describe("truncateToolOutput", () => {
	it("passes short content through unchanged", () => {
		expect(truncateToolOutput("hello")).toBe("hello");
	});
	it("truncates content past the limit with a marker", () => {
		const content = "x".repeat(8100);
		const out = truncateToolOutput(content);
		expect(out.length).toBe(8000 + "\n…(truncated)".length);
		expect(out.endsWith("\n…(truncated)")).toBe(true);
	});
	it("respects a custom limit", () => {
		expect(truncateToolOutput("abcdefgh", 4)).toBe("abcd\n…(truncated)");
	});
});

describe("truncateInline", () => {
	it("passes short strings through", () => {
		expect(truncateInline("short", 10)).toBe("short");
	});
	it("truncates with an ellipsis at the limit", () => {
		expect(truncateInline("abcdefghij", 5)).toBe("abcde…");
	});
});

describe("escapeHtml", () => {
	it("escapes the five reserved characters", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	});
	it("leaves plain text untouched", () => {
		expect(escapeHtml("just plain text")).toBe("just plain text");
	});
});

describe("summarizeExportItem", () => {
	it("summarizes a thinking item with a truncated preview", () => {
		const item: ActivityItem = { kind: "thinking", text: "  line one\n  line two  ", id: "t1" };
		expect(summarizeExportItem(item)).toBe("Thinking: line one line two");
	});
	it("falls back to the bare label for an empty thinking item", () => {
		const item: ActivityItem = { kind: "thinking", text: "   ", id: "t1" };
		expect(summarizeExportItem(item)).toBe("Thinking");
	});
	it("prefers input.command for a tool item", () => {
		const item: ActivityItem = {
			kind: "tool",
			entry: { toolUseId: "1", name: "Bash", input: { command: "ls -la" } },
		};
		expect(summarizeExportItem(item)).toBe("Bash: ls -la");
	});
	it("falls back to input.file_path, then input.path", () => {
		const withFilePath: ActivityItem = {
			kind: "tool",
			entry: { toolUseId: "1", name: "Read", input: { file_path: "/a/b.ts" } },
		};
		expect(summarizeExportItem(withFilePath)).toBe("Read: /a/b.ts");

		const withPath: ActivityItem = {
			kind: "tool",
			entry: { toolUseId: "1", name: "Read", input: { path: "/a/b.ts" } },
		};
		expect(summarizeExportItem(withPath)).toBe("Read: /a/b.ts");
	});
	it("falls back to truncated JSON.stringify(input) for other shapes", () => {
		const item: ActivityItem = {
			kind: "tool",
			entry: { toolUseId: "1", name: "Weird", input: { foo: 1, bar: 2 } },
		};
		expect(summarizeExportItem(item)).toBe('Weird: {"foo":1,"bar":2}');
	});
	it("uses the bare tool name when input has no usable field", () => {
		const item: ActivityItem = { kind: "tool", entry: { toolUseId: "1", name: "Noop", input: undefined } };
		expect(summarizeExportItem(item)).toBe("Noop");
	});
	it("prefixes an error tool call with a warning marker", () => {
		const item: ActivityItem = {
			kind: "tool",
			entry: {
				toolUseId: "1",
				name: "Bash",
				input: { command: "false" },
				result: { content: "boom", isError: true },
			},
		};
		expect(summarizeExportItem(item)).toBe("⚠️ Bash: false");
	});
});
