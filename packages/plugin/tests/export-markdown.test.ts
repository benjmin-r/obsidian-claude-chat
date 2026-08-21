import { renderMarkdown } from "../src/export-markdown";
import type { ExportMeta } from "../src/export-shared";
import type { DisplayItem } from "../src/view-model";
import {
	errorToolFixture,
	longOutputFixture,
	multiToolFixture,
	plainQaFixture,
	sampleMeta,
	sampleTimestamps,
	successfulToolFixture,
	thinkingFixture,
} from "./fixtures/export-fixtures";

describe("renderMarkdown", () => {
	it("emits YAML frontmatter carrying the session id, model, updated date, and title", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out.startsWith("---\n")).toBe(true);
		expect(out).toContain(`session_id: ${sampleMeta.sessionId}`);
		expect(out).toContain(`model: ${sampleMeta.model}`);
		expect(out).toContain("updated: 2026-08-18T08:41:01.332Z");
		expect(out).toContain(`title: "${sampleMeta.title}"`);
	});

	it("omits the updated field when updatedAt is absent", () => {
		const meta: ExportMeta = { sessionId: "s1", title: "No date", model: "claude-sonnet-5" };
		const out = renderMarkdown(plainQaFixture, meta);
		expect(out).not.toContain("updated:");
	});

	it("renders a title heading and a metadata line with a conversation link", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).toContain(`# ${sampleMeta.title}`);
		expect(out).toContain(`[${sampleMeta.title}](obsidian://occ-chat?session=${sampleMeta.sessionId})`);
	});

	it("renders user/assistant turns with You:/Claude: prefixes", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).toContain("**You:**\nWhat does the `groupActivity` reducer do?");
		expect(out).toContain("**Claude:**\n");
	});

	it("suffixes a turn with a formatted HH:mm timestamp when the messageId is in the map", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta, sampleTimestamps);
		// u1 -> 2026-08-18T08:41:00Z, formatted in local time
		const expected = new Date(sampleTimestamps.u1!);
		const hh = String(expected.getHours()).padStart(2, "0");
		const mm = String(expected.getMinutes()).padStart(2, "0");
		expect(out).toContain(`**You:** \`${hh}:${mm}\`\n`);
	});

	it("omits the timestamp silently when the messageId has no entry", () => {
		const out = renderMarkdown(successfulToolFixture, sampleMeta, sampleTimestamps);
		// successfulToolFixture's turns (u3/a3) are absent from sampleTimestamps
		expect(out).toContain("**You:**\nList the files");
		expect(out).not.toMatch(/\*\*You:\*\* `\d{2}:\d{2}`\nList the files/);
	});

	it("wraps a collapsed activity group in nested <details>/<summary>", () => {
		const out = renderMarkdown(thinkingFixture, sampleMeta);
		expect(out).toContain("<details>\n<summary>");
		// group summary + nested thinking summary => at least two <details> blocks
		expect(out.match(/<details>/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("pretty-prints tool input as an escaped <pre> block, not a fenced code block", () => {
		// Obsidian treats content inside a <details> HTML block as opaque HTML, not
		// re-parsed markdown (see TDL-20260820-012) — a ``` fence there renders as
		// literal text, so nested content must be raw HTML instead.
		const out = renderMarkdown(successfulToolFixture, sampleMeta);
		expect(out).toContain("<pre>{\n  &quot;command&quot;: &quot;ls packages/plugin/src&quot;\n}</pre>");
		expect(out).not.toContain("```json");
	});

	it("renders tool result as an escaped <pre> block", () => {
		const out = renderMarkdown(successfulToolFixture, sampleMeta);
		expect(out).toContain("<pre>chat-view.ts\nmain.ts\nview-model.ts</pre>");
	});

	it("marks an error tool call with a warning icon in the summary line", () => {
		const out = renderMarkdown(errorToolFixture, sampleMeta);
		expect(out).toContain("⚠️ Bash: rm build/missing.log");
	});

	it("truncates a long tool output at the shared limit", () => {
		const out = renderMarkdown(longOutputFixture, sampleMeta);
		expect(out).toContain("…(truncated)");
		const fullContent = "line of build output\n".repeat(500);
		expect(out).not.toContain(fullContent);
	});

	it("folds multiple tool calls plus a leading thinking step into one group", () => {
		const out = renderMarkdown(multiToolFixture, sampleMeta);
		expect(out).toContain("Thinking: I&#39;ll read the file first, then apply the rename.");
		expect(out).toContain("Read: src/util.ts");
		expect(out).toContain("Edit: src/util.ts");
	});

	it("escapes HTML-sensitive characters in both the summary label and the <pre> body", () => {
		const items: DisplayItem[] = [
			{
				kind: "activity",
				key: "g",
				items: [
					{
						kind: "tool",
						entry: {
							toolUseId: "1",
							name: "Bash",
							input: { command: "<script>alert(1)</script>" },
							result: { content: "<b>raw</b>", isError: false },
						},
					},
				],
			},
		];
		const out = renderMarkdown(items, sampleMeta);
		expect(out).toContain("Bash: &lt;script&gt;alert(1)&lt;/script&gt;");
		expect(out).toContain("<pre>&lt;b&gt;raw&lt;/b&gt;</pre>");
		expect(out).not.toContain("<b>raw</b>");
	});

	it("renders an error item as a blockquote with a warning icon", () => {
		const items: DisplayItem[] = [{ kind: "error", text: "Connection lost" }];
		const out = renderMarkdown(items, sampleMeta);
		expect(out).toContain("> ⚠️ Connection lost");
	});
});
