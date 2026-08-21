/**
 * Pure Markdown transcript renderer. No Obsidian imports — consumes the same
 * `DisplayItem[]` shape the live view renders (`groupActivity` output,
 * `view-model.ts`); the caller folds render events into that shape once, this
 * module never re-derives grouping.
 */

import type { ActivityGroup, ActivityItem, DisplayItem } from "./view-model";
import { escapeHtml, summarizeExportItem, truncateInline, truncateToolOutput, type ExportMeta } from "./export-shared";
import { conversationLinkFromParts } from "./occ-links";

/** Cap on a collapsed activity group's comma-joined summary line. */
const GROUP_LABEL_LIMIT = 200;

function yamlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatTimeHHmm(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function frontmatter(meta: ExportMeta): string {
	const lines = ["---", `session_id: ${meta.sessionId}`, `model: ${meta.model}`];
	if (meta.updatedAt !== undefined) lines.push(`updated: ${new Date(meta.updatedAt).toISOString()}`);
	lines.push(`title: ${yamlString(meta.title)}`, "---");
	return lines.join("\n");
}

function metadataLine(meta: ExportMeta): string {
	const dateStr = meta.updatedAt !== undefined ? new Date(meta.updatedAt).toISOString().slice(0, 10) : undefined;
	const parts = [meta.model, dateStr, conversationLinkFromParts(meta.sessionId, meta.title)].filter(
		(p): p is string => !!p
	);
	return `*${parts.join(" · ")}*`;
}

function turnBlock(
	who: "You" | "Claude",
	text: string,
	id: string | undefined,
	timestamps: Record<string, number>
): string {
	const ts = id !== undefined ? timestamps[id] : undefined;
	const suffix = ts !== undefined ? ` \`${formatTimeHHmm(ts)}\`` : "";
	return `**${who}:**${suffix}\n${text}`;
}

/**
 * Content nested inside a `<details>` block, per TDL-20260820-012: Obsidian's
 * markdown renderer treats everything between raw HTML tags as opaque HTML, not
 * re-parsed markdown, so fenced code blocks placed there never render as code —
 * they show up as literal ``` text. Emit escaped `<pre>` HTML instead (matching
 * `export-html.ts`) so nested content renders correctly regardless.
 */
function toolDetail(item: ActivityItem): string {
	if (item.kind === "thinking") {
		return `<details>\n<summary>${escapeHtml(summarizeExportItem(item))}</summary>\n<pre>${escapeHtml(item.text)}</pre>\n</details>`;
	}
	const { entry } = item;
	const blocks: string[] = [];
	if (entry.input !== undefined) blocks.push(`<pre>${escapeHtml(JSON.stringify(entry.input, null, 2))}</pre>`);
	if (entry.result) blocks.push(`<pre>${escapeHtml(truncateToolOutput(entry.result.content))}</pre>`);
	return `<details>\n<summary>${escapeHtml(summarizeExportItem(item))}</summary>\n${blocks.join("\n")}\n</details>`;
}

/** Timestamps are shown at turn granularity only (see TDL-20260820-010) — an activity group's
 * nested thinking/tool items never carry their own, matching how a transcript reads naturally. */
function activityGroupBlock(group: ActivityGroup): string {
	const label = escapeHtml(truncateInline(group.items.map(summarizeExportItem).join(", "), GROUP_LABEL_LIMIT));
	const inner = group.items.map((item) => toolDetail(item)).join("\n");
	return `<details>\n<summary>${label}</summary>\n${inner}\n</details>`;
}

function renderItem(item: DisplayItem, timestamps: Record<string, number>): string {
	switch (item.kind) {
		case "user":
			return turnBlock("You", item.text, item.id, timestamps);
		case "assistant":
			return turnBlock("Claude", item.text, item.id, timestamps);
		case "error":
			return `> ⚠️ ${item.text}`;
		case "activity":
			return activityGroupBlock(item);
	}
}

/**
 * Render a full transcript to Markdown: YAML frontmatter (carries `session_id`
 * since it's no longer in the filename), a title heading, a metadata line linking
 * back to the conversation, then each turn/activity group in order. `timestamps`
 * maps a user/assistant/thinking item's `messageId` to an epoch-ms best-effort
 * backfill (see TDL-20260820-010) — entries without a match render without a
 * timestamp, silently.
 */
export function renderMarkdown(
	items: DisplayItem[],
	meta: ExportMeta,
	timestamps: Record<string, number> = {}
): string {
	const sections = [
		frontmatter(meta),
		`# ${meta.title}`,
		metadataLine(meta),
		...items.map((item) => renderItem(item, timestamps)),
	];
	return sections.join("\n\n").trimEnd() + "\n";
}
