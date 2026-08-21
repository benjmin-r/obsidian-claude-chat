/**
 * Pure helpers shared by the export renderer (`export-markdown.ts`) and the
 * eventual vault-write path. No Obsidian imports — kept transport- and DOM-free
 * so the renderer can be exercised standalone (unit tests, the fixture preview
 * script) without a running plugin or server.
 */

import type { ActivityItem, ToolEntry } from "./view-model";

export interface ExportMeta {
	sessionId: string;
	title: string;
	model: string;
	/** epoch ms of last activity, if known — drives the filename date and doc metadata. */
	updatedAt?: number;
}

/** Max characters of tool output kept before truncation. Shared with the live view (chat-view.ts). */
export const TOOL_OUTPUT_LIMIT = 8000;

/** Truncate long tool output, matching the live view's in-transcript truncation. */
export function truncateToolOutput(content: string, limit = TOOL_OUTPUT_LIMIT): string {
	return content.length > limit ? content.slice(0, limit) + "\n…(truncated)" : content;
}

/** Shorten an inline string with an ellipsis, for one-liner summaries. */
export function truncateInline(s: string, limit: number): string {
	return s.length > limit ? s.slice(0, limit) + "…" : s;
}

/** Preferred single-field keys to surface inline for a tool call, in priority order. */
const INPUT_FIELD_KEYS = ["command", "file_path", "path"];

function inputPreview(input: unknown): string {
	if (input && typeof input === "object") {
		const obj = input as Record<string, unknown>;
		for (const key of INPUT_FIELD_KEYS) {
			const v = obj[key];
			if (typeof v === "string" && v) return truncateInline(v, 120);
		}
		return truncateInline(JSON.stringify(input), 120);
	}
	return "";
}

function summarizeToolEntry(entry: ToolEntry): string {
	const preview = inputPreview(entry.input);
	const label = preview ? `${entry.name}: ${preview}` : entry.name;
	return entry.result?.isError ? `⚠️ ${label}` : label;
}

/**
 * A richer per-item one-liner than the live view's coarse `summarizeActivity`
 * (which only counts items) — used as the `<summary>` label for each individual
 * thinking/tool row, and joined across a group for the group's own summary line.
 */
export function summarizeExportItem(item: ActivityItem): string {
	if (item.kind === "thinking") {
		const preview = item.text.replace(/\s+/g, " ").trim();
		return preview ? `Thinking: ${truncateInline(preview, 120)}` : "Thinking";
	}
	return summarizeToolEntry(item.entry);
}

const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** Strip filesystem-illegal characters, collapse whitespace, cap length. */
export function sanitizeFilename(title: string): string {
	const cleaned = title.replace(ILLEGAL_FILENAME_CHARS, "").replace(/\s+/g, " ").trim();
	const capped = cleaned.slice(0, 80).trim();
	return capped || "Untitled session";
}

function dateParts(updatedAt: number | undefined): { yyyymmdd: string; yyyyMm: string } {
	const d = updatedAt !== undefined ? new Date(updatedAt) : new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return { yyyymmdd: `${y}${m}${day}`, yyyyMm: `${y}-${m}` };
}

/**
 * Date-led, human-readable export path: `{base}[/{YYYY-MM}]/{YYYYMMDD} - {title}.{ext}`.
 * The session id lives in the document's own metadata, not the filename (see
 * TDL-20260820-010) — collisions between two sessions sharing a date+title are
 * resolved by the caller (export-writer.ts) via `suffix`, appended here as ` (n)`.
 */
export function exportFilePath(
	base: string,
	groupByMonth: boolean,
	title: string,
	updatedAt: number | undefined,
	ext: string,
	suffix?: number
): string {
	const { yyyymmdd, yyyyMm } = dateParts(updatedAt);
	const folder = groupByMonth ? `${base}/${yyyyMm}` : base;
	const suffixText = suffix && suffix > 1 ? ` (${suffix})` : "";
	return `${folder}/${yyyymmdd} - ${sanitizeFilename(title)}${suffixText}.${ext}`;
}
