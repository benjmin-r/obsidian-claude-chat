/**
 * Pure Markdown transcript renderer. No Obsidian imports — consumes the same
 * `DisplayItem[]` shape the live view renders (`groupActivity` output,
 * `view-model.ts`); the caller folds render events into that shape once, this
 * module never re-derives grouping.
 */

import type { ActivityGroup, ActivityItem, DisplayItem, ToolEntry } from "./view-model";
import { summarizeExportItem, truncateToolOutput, type ExportMeta } from "./export-shared";
import { conversationLinkFromParts } from "./occ-links";

function yamlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Frontmatter's `conversation` field is a real Markdown link
 * (`[title](obsidian://occ-chat?session=…)`), not a `[[wikilink]]` —
 * wikilinks only resolve to vault notes by title, they can't invoke a custom
 * protocol handler. Obsidian's Properties panel renders a Markdown link in a
 * text property as clickable, so this is still a single click to jump back
 * into the live chat (as long as the session is still available on the
 * server — see TDL-20260825-001/-002).
 */
function frontmatter(meta: ExportMeta): string {
	const lines = ["---", `session_id: ${meta.sessionId}`, `model: ${meta.model}`];
	if (meta.createdAt !== undefined) lines.push(`created: ${new Date(meta.createdAt).toISOString()}`);
	if (meta.updatedAt !== undefined) lines.push(`updated: ${new Date(meta.updatedAt).toISOString()}`);
	lines.push(
		`title: ${yamlString(meta.title)}`,
		`conversation: ${yamlString(conversationLinkFromParts(meta.sessionId, meta.title))}`,
		"---"
	);
	return lines.join("\n");
}

function turnBlock(who: "You" | "Claude", text: string): string {
	return `**${who}** · ${text}`;
}

/** Prefix every line (including blank separator lines) with `> ` so it stays inside the enclosing callout. */
function quoteLines(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * Flat, single-level Obsidian callout: `> [!type]- title` header, folded closed
 * by default (the `-` modifier), followed by the quoted body. Callout content is
 * parsed as real markdown (unlike raw `<details>` HTML — see TDL-20260821-014),
 * so fenced code blocks inside `body` render with syntax highlighting.
 */
function callout(type: "info" | "success" | "failure", title: string, body: string): string {
	const header = `> [!${type}]- ${title}`;
	return body ? `${header}\n${quoteLines(body)}` : header;
}

function toolCalloutBody(entry: ToolEntry): string {
	const blocks: string[] = [];
	if (entry.input !== undefined) blocks.push("```json\n" + JSON.stringify(entry.input, null, 2) + "\n```");
	if (entry.result) blocks.push("```\n" + truncateToolOutput(entry.result.content) + "\n```");
	return blocks.join("\n\n");
}

/**
 * Each thinking/tool step in a run gets its own independent callout — never
 * nested inside a group wrapper, which would force a pointless double-expand
 * click for a single-item run (see TDL-20260821-014).
 */
function activityItemBlock(item: ActivityItem): string {
	if (item.kind === "thinking") return callout("info", summarizeExportItem(item), item.text);
	const type = item.entry.result?.isError ? "failure" : "success";
	return callout(type, summarizeExportItem(item), toolCalloutBody(item.entry));
}

function activityBlock(group: ActivityGroup): string {
	return group.items.map((item) => activityItemBlock(item)).join("\n\n");
}

function renderItem(item: DisplayItem): string {
	switch (item.kind) {
		case "user":
			return turnBlock("You", item.text);
		case "assistant":
			return turnBlock("Claude", item.text);
		case "error":
			return `> ⚠️ **Error:** ${item.text}`;
		case "activity":
			return activityBlock(item);
	}
}

/**
 * Render a full transcript to Markdown: YAML frontmatter (`session_id`, `model`,
 * `created` — first message, `updated` — last message, `title`, `conversation`
 * — a clickable `obsidian://` link back to the live chat) followed immediately
 * by the turns/activity in order, each consecutive block separated by a `---`
 * divider. Joining via `.join("\n\n---\n\n")` rather than appending a divider
 * inside each block avoids a stray trailing rule after the last block.
 */
export function renderMarkdown(items: DisplayItem[], meta: ExportMeta): string {
	const body = items.map((item) => renderItem(item)).join("\n\n---\n\n");
	return [frontmatter(meta), body].join("\n\n").trimEnd() + "\n";
}
