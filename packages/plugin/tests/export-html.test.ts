import { renderHtml } from "../src/export-html";
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

describe("renderHtml", () => {
	it("leads with an occ-session-id comment and carries a matching meta tag", () => {
		const out = renderHtml(plainQaFixture, sampleMeta);
		expect(out.startsWith(`<!-- occ-session-id: ${sampleMeta.sessionId} -->\n`)).toBe(true);
		expect(out).toContain(`<meta name="occ-session-id" content="${sampleMeta.sessionId}">`);
	});

	it("is a self-contained document: doctype, viewport meta, inline style, no external refs", () => {
		const out = renderHtml(plainQaFixture, sampleMeta);
		expect(out).toContain("<!doctype html>");
		expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(out).toContain("<style>");
		expect(out).not.toMatch(/https?:\/\//);
		expect(out).not.toContain("<link ");
		expect(out).not.toContain("<script");
	});

	it("declares dark-mode styling via prefers-color-scheme", () => {
		const out = renderHtml(plainQaFixture, sampleMeta);
		expect(out).toContain("@media (prefers-color-scheme: dark)");
	});

	it("escapes the title in both <title> and <h1>", () => {
		const meta: ExportMeta = { sessionId: "s1", title: "<b>Bold</b> & risky", model: "claude-sonnet-5" };
		const out = renderHtml(plainQaFixture, meta);
		expect(out).toContain("<title>&lt;b&gt;Bold&lt;/b&gt; &amp; risky</title>");
		expect(out).toContain("<h1>&lt;b&gt;Bold&lt;/b&gt; &amp; risky</h1>");
	});

	it("renders user/assistant turns with escaped text", () => {
		const items: DisplayItem[] = [{ kind: "user", text: "<script>alert(1)</script>", id: "u1" }];
		const out = renderHtml(items, sampleMeta);
		expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(out).not.toContain("<script>alert(1)</script>");
	});

	it("suffixes a turn with a formatted HH:mm timestamp when present, omits it otherwise", () => {
		const withTs = renderHtml(plainQaFixture, sampleMeta, sampleTimestamps);
		const expected = new Date(sampleTimestamps.u1!);
		const hh = String(expected.getHours()).padStart(2, "0");
		const mm = String(expected.getMinutes()).padStart(2, "0");
		expect(withTs).toContain(`<span class="occ-ts">${hh}:${mm}</span>`);

		const withoutTs = renderHtml(successfulToolFixture, sampleMeta, sampleTimestamps);
		expect(withoutTs).not.toContain('<span class="occ-ts">');
	});

	it("nests activity groups as two-level <details>/<summary>", () => {
		const out = renderHtml(thinkingFixture, sampleMeta);
		expect(out).toContain('<details class="occ-activity">');
		expect((out.match(/<details/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("marks an error tool call's <details> with the error class", () => {
		const out = renderHtml(errorToolFixture, sampleMeta);
		expect(out).toContain('<details class="occ-tool occ-tool-error">');
	});

	it("truncates a long tool output at the shared limit", () => {
		const out = renderHtml(longOutputFixture, sampleMeta);
		expect(out).toContain("…(truncated)");
		const fullContent = "line of build output\n".repeat(500);
		expect(out).not.toContain(fullContent);
	});

	it("folds multiple tool calls plus a leading thinking step into one group", () => {
		const out = renderHtml(multiToolFixture, sampleMeta);
		expect(out).toContain("Thinking: I&#39;ll read the file first, then apply the rename.");
		expect(out).toContain("Read: src/util.ts");
		expect(out).toContain("Edit: src/util.ts");
	});

	it("renders an error item with a warning icon", () => {
		const items: DisplayItem[] = [{ kind: "error", text: "Connection lost" }];
		const out = renderHtml(items, sampleMeta);
		expect(out).toContain('<p class="occ-error">⚠️ Connection lost</p>');
	});
});
