import { renderMarkdown } from "../src/export-markdown";
import { summarizeExportItem, type ExportMeta } from "../src/export-shared";
import type { DisplayItem } from "../src/view-model";
import {
	errorToolFixture,
	longOutputFixture,
	multiToolFixture,
	plainQaFixture,
	sampleMeta,
	successfulToolFixture,
	thinkingFixture,
} from "./fixtures/export-fixtures";

/** Mirrors export-markdown.ts's isoLocal — local `YYYY-MM-DDTHH:mm:ss`, the shape
 * Obsidian's own Date & time property picker writes (unlike a Z/ms ISO string). */
function localIso(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe("renderMarkdown", () => {
	it("emits YAML frontmatter carrying the session id, model, created/updated dates (local, Obsidian-datetime-recognized), and a conversation markdown link — no separate title field", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out.startsWith("---\n")).toBe(true);
		expect(out).toContain(`session_id: ${sampleMeta.sessionId}`);
		expect(out).toContain(`model: ${sampleMeta.model}`);
		expect(out).toContain(`created: ${localIso(sampleMeta.createdAt!)}`);
		expect(out).toContain(`updated: ${localIso(sampleMeta.updatedAt!)}`);
		expect(out).not.toMatch(/^title:/m);
		expect(out).toContain(
			`conversation: "[${sampleMeta.title}](obsidian://occ-chat?session=${sampleMeta.sessionId})"`
		);
	});

	it("formats created/updated without milliseconds or a Z suffix (so Obsidian recognizes them as Date & time, not text)", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).toMatch(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
		expect(out).toMatch(/updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
		expect(out).not.toMatch(/created: .*Z/);
		expect(out).not.toMatch(/updated: .*Z/);
	});

	it("omits the created/updated fields when createdAt/updatedAt are absent, but still links the conversation", () => {
		const meta: ExportMeta = { sessionId: "s1", title: "No date", model: "claude-sonnet-5" };
		const out = renderMarkdown(plainQaFixture, meta);
		expect(out).not.toContain("created:");
		expect(out).not.toContain("updated:");
		expect(out).toContain('conversation: "[No date](obsidian://occ-chat?session=s1)"');
	});

	it("links back to the live chat with a real markdown link, not a [[wikilink]] (wikilinks can't invoke a protocol handler)", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).not.toMatch(/conversation:.*\[\[/);
		expect(out).toMatch(/conversation: "\[.*]\(obsidian:\/\/occ-chat\?session=/);
	});

	it("has no H1 heading or metadata line — the body starts immediately after frontmatter", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).not.toContain(`# ${sampleMeta.title}`);
		expect(out).toContain(`---\n\n**You** · ${(plainQaFixture[0] as { text: string }).text}`);
	});

	it("renders user/assistant turns as a bold label, middle dot, and text — no timestamp", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out).toContain("**You** · What does the `groupActivity` reducer do?");
		expect(out).toContain(
			"**Claude** · It folds consecutive tool/thinking items into a single collapsible `ActivityGroup`"
		);
		expect(out).not.toMatch(/`\d{2}:\d{2}`/);
	});

	it("renders a thinking activity item as a flat, closed-by-default info callout", () => {
		const out = renderMarkdown(thinkingFixture, sampleMeta);
		const group = thinkingFixture[1] as Extract<DisplayItem, { kind: "activity" }>;
		const thinkingItem = group.items[0]!;
		const title = summarizeExportItem(thinkingItem);
		expect(out).toContain(`> [!info]- ${title}`);
		expect(out).toContain(`> ${(thinkingItem as { text: string }).text}`);
		expect(out).not.toContain("<details>");
	});

	it("renders a successful tool call as a flat success callout with fenced json input and fenced output", () => {
		const out = renderMarkdown(successfulToolFixture, sampleMeta);
		expect(out).toContain("> [!success]- Bash: ls packages/plugin/src");
		expect(out).toContain("> ```json");
		expect(out).toContain('>   "command": "ls packages/plugin/src"');
		expect(out).toContain("> chat-view.ts");
		expect(out).toContain("> main.ts");
		expect(out).not.toContain("<pre>");
		expect(out).not.toContain("<details>");
	});

	it("marks an errored tool call with a failure callout, warning icon from the shared summary label", () => {
		const out = renderMarkdown(errorToolFixture, sampleMeta);
		expect(out).toContain("> [!failure]- ⚠️ Bash: rm build/missing.log");
	});

	it("truncates a long tool output within the fenced block at the shared limit", () => {
		const out = renderMarkdown(longOutputFixture, sampleMeta);
		expect(out).toContain("…(truncated)");
		const fullContent = "line of build output\n".repeat(500);
		expect(out).not.toContain(fullContent);
	});

	it("flattens a multi-item activity run into consecutive callouts with no group wrapper and no divider between them", () => {
		const out = renderMarkdown(multiToolFixture, sampleMeta);
		expect(out).toContain("Thinking: I'll read the file first, then apply the rename.");
		expect(out).toContain("> [!success]- Read: src/util.ts");
		expect(out).toContain("> [!success]- Edit: src/util.ts");

		const headers = out.match(/> \[!(info|success|failure)]-/g) ?? [];
		expect(headers.length).toBe(3);

		// no comma-joined outer group summary, and no "---" divider between the flat callouts
		expect(out).not.toContain("Thinking: I'll read the file first, then apply the rename., Read:");
		const firstIdx = out.indexOf("> [!info]-");
		const lastIdx = out.lastIndexOf("> [!success]-");
		expect(out.slice(firstIdx, lastIdx)).not.toContain("\n\n---\n\n");
	});

	it("renders an error item as a plain blockquote, not a callout", () => {
		const items: DisplayItem[] = [{ kind: "error", text: "Connection lost" }];
		const out = renderMarkdown(items, sampleMeta);
		expect(out).toContain("> ⚠️ **Error:** Connection lost");
		expect(out).not.toContain("[!");
	});

	it("separates every consecutive block — turn, activity run, turn — with a divider", () => {
		const out = renderMarkdown(successfulToolFixture, sampleMeta);
		const dividerCount = (out.match(/\n\n---\n\n/g) ?? []).length;
		expect(dividerCount).toBe(2);
	});

	it("has no stray trailing divider or blank line after the final block", () => {
		const out = renderMarkdown(plainQaFixture, sampleMeta);
		expect(out.endsWith("\n")).toBe(true);
		expect(out.endsWith("---\n")).toBe(false);
		expect(out.endsWith("\n\n")).toBe(false);
	});

	it("inserts text as-is into real markdown context — no escaping needed anywhere", () => {
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
		expect(out).toContain("<script>alert(1)</script>");
		expect(out).toContain("<b>raw</b>");
		expect(out).not.toContain("&lt;");
	});
});
