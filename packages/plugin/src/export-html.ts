/**
 * Pure self-contained HTML transcript renderer. No Obsidian imports, no external
 * assets (per AGENTS.md's "one network destination" posture) — everything is
 * inlined so the file opens standalone in a browser. Shares content-shaping logic
 * with `export-markdown.ts` via `export-shared.ts` so the two formats never drift.
 */

import type { ActivityGroup, ActivityItem, DisplayItem } from "./view-model";
import { escapeHtml, summarizeExportItem, truncateInline, truncateToolOutput, type ExportMeta } from "./export-shared";

/** Cap on a collapsed activity group's comma-joined summary line. */
const GROUP_LABEL_LIMIT = 200;

const STYLE = `
:root { color-scheme: light dark; }
body {
	max-width: 760px;
	margin: 2rem auto;
	padding: 0 1rem;
	font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	background: #fff;
	color: #1c1c1e;
}
h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
.occ-meta { color: #6e6e73; font-size: 0.85rem; margin-top: 0; }
.occ-meta a { color: inherit; }
.occ-turn { margin: 1rem 0; white-space: pre-wrap; }
.occ-turn strong { color: #1c1c1e; }
.occ-ts { color: #8e8e93; font-size: 0.8em; font-weight: normal; }
.occ-error { color: #c0392b; }
details {
	margin: 0.4rem 0;
	border: 1px solid #e0e0e0;
	border-radius: 6px;
	padding: 0.3rem 0.6rem;
	background: #f7f7f8;
}
details details { background: #fbfbfc; margin-top: 0.4rem; }
summary {
	cursor: pointer;
	font-size: 0.85rem;
	color: #444;
	white-space: pre-wrap;
}
.occ-tool-error > summary { color: #c0392b; }
pre {
	white-space: pre-wrap;
	word-break: break-word;
	font-size: 0.8rem;
	background: #f0f0f2;
	border-radius: 4px;
	padding: 0.5rem;
	overflow-x: auto;
}
@media (prefers-color-scheme: dark) {
	body { background: #1c1c1e; color: #e5e5e7; }
	h1, .occ-turn strong { color: #f2f2f7; }
	.occ-meta { color: #98989d; }
	.occ-ts { color: #8e8e93; }
	details { background: #2c2c2e; border-color: #3a3a3c; }
	details details { background: #232325; }
	summary { color: #d1d1d6; }
	pre { background: #232325; }
}
`.trim();

function formatTimeHHmm(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function turnHtml(
	who: "You" | "Claude",
	text: string,
	id: string | undefined,
	timestamps: Record<string, number>
): string {
	const ts = id !== undefined ? timestamps[id] : undefined;
	const suffix = ts !== undefined ? ` <span class="occ-ts">${formatTimeHHmm(ts)}</span>` : "";
	return `<p class="occ-turn"><strong>${who}:</strong>${suffix} ${escapeHtml(text)}</p>`;
}

function toolDetailHtml(item: ActivityItem): string {
	const label = escapeHtml(summarizeExportItem(item));
	if (item.kind === "thinking") {
		return `<details><summary>${label}</summary><pre>${escapeHtml(item.text)}</pre></details>`;
	}
	const { entry } = item;
	const blocks: string[] = [];
	if (entry.input !== undefined) blocks.push(`<pre>${escapeHtml(JSON.stringify(entry.input, null, 2))}</pre>`);
	if (entry.result) blocks.push(`<pre>${escapeHtml(truncateToolOutput(entry.result.content))}</pre>`);
	const cls = entry.result?.isError ? " occ-tool-error" : "";
	return `<details class="occ-tool${cls}"><summary>${label}</summary>${blocks.join("")}</details>`;
}

/** Timestamps are shown at turn granularity only (see TDL-20260820-010) — an activity
 * group's nested thinking/tool items never carry their own timestamp. */
function activityGroupHtml(group: ActivityGroup): string {
	const label = escapeHtml(truncateInline(group.items.map(summarizeExportItem).join(", "), GROUP_LABEL_LIMIT));
	const inner = group.items.map((item) => toolDetailHtml(item)).join("");
	return `<details class="occ-activity"><summary>${label}</summary>${inner}</details>`;
}

function renderItem(item: DisplayItem, timestamps: Record<string, number>): string {
	switch (item.kind) {
		case "user":
			return turnHtml("You", item.text, item.id, timestamps);
		case "assistant":
			return turnHtml("Claude", item.text, item.id, timestamps);
		case "error":
			return `<p class="occ-error">⚠️ ${escapeHtml(item.text)}</p>`;
		case "activity":
			return activityGroupHtml(item);
	}
}

/**
 * Render a full transcript to a self-contained HTML document: inline `<style>`
 * (light/dark via `prefers-color-scheme`), native `<details>/<summary>` two-level
 * nesting matching the live view, and the session id in both a leading HTML
 * comment and a `<meta>` tag (machine + human inspectable — the filename no
 * longer carries it, see TDL-20260820-010).
 */
export function renderHtml(items: DisplayItem[], meta: ExportMeta, timestamps: Record<string, number> = {}): string {
	const title = escapeHtml(meta.title);
	const dateStr = meta.updatedAt !== undefined ? new Date(meta.updatedAt).toISOString().slice(0, 10) : undefined;
	const metaParts = [escapeHtml(meta.model), dateStr].filter((p): p is string => !!p).join(" · ");
	const body = items.map((item) => renderItem(item, timestamps)).join("\n");
	return `<!-- occ-session-id: ${meta.sessionId} -->
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="occ-session-id" content="${escapeHtml(meta.sessionId)}">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${title}</h1>
<p class="occ-meta">${metaParts}</p>
${body}
</body>
</html>
`;
}
