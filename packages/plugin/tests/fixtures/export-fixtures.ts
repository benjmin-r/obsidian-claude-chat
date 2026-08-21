/**
 * Hand-built `DisplayItem[]` scenarios for the export renderer — used by its
 * unit tests and by `scripts/render-export-fixtures.ts` (the standalone preview
 * tool that writes sample `.md` files into a vault for visual review).
 * Each scenario is what `groupActivity(events.reduce(applyEvent, ...).items)`
 * would produce for a real session; built by hand here so the renderer can be
 * developed and reviewed without a live server or SDK session.
 */

import type { DisplayItem } from "../../src/view-model";
import type { ExportMeta } from "../../src/export-shared";

export interface ExportScenario {
	name: string;
	title: string;
	items: DisplayItem[];
}

/** Plain back-and-forth, no thinking or tool activity. */
export const plainQaFixture: DisplayItem[] = [
	{ kind: "user", text: "What does the `groupActivity` reducer do?", id: "u1" },
	{
		kind: "assistant",
		text: "It folds consecutive tool/thinking items into a single collapsible `ActivityGroup`, so a long chain of steps renders as one row instead of flooding the transcript.",
		id: "a1",
	},
];

/** A thinking block between two turns. */
export const thinkingFixture: DisplayItem[] = [
	{ kind: "user", text: "Why is the nightly build slow?", id: "u2" },
	{
		kind: "activity",
		key: "g-thinking",
		items: [
			{
				kind: "thinking",
				text: "The build runs protocol, server, and plugin sequentially even though protocol and the plugin's non-server-dependent checks could run in parallel. Let me check the npm script to confirm the ordering constraint is real before suggesting a change.",
				id: "t1",
			},
		],
	},
	{
		kind: "assistant",
		text: "Because `npm run build` runs protocol → server → plugin serially, and each step waits for `tsc` to finish before the next starts.",
		id: "a2",
	},
];

/** A single successful tool call. */
export const successfulToolFixture: DisplayItem[] = [
	{ kind: "user", text: "List the files in packages/plugin/src.", id: "u3" },
	{
		kind: "activity",
		key: "g-tool-ok",
		items: [
			{
				kind: "tool",
				entry: {
					toolUseId: "tool-ls",
					name: "Bash",
					input: { command: "ls packages/plugin/src" },
					result: { content: "chat-view.ts\nmain.ts\nview-model.ts", isError: false },
				},
			},
		],
	},
	{ kind: "assistant", text: "Here's the listing above.", id: "a3" },
];

/** A tool call that fails, to exercise the error marker/styling. */
export const errorToolFixture: DisplayItem[] = [
	{ kind: "user", text: "Delete build/missing.log", id: "u4" },
	{
		kind: "activity",
		key: "g-tool-error",
		items: [
			{
				kind: "tool",
				entry: {
					toolUseId: "tool-rm",
					name: "Bash",
					input: { command: "rm build/missing.log" },
					result: { content: "rm: build/missing.log: No such file or directory", isError: true },
				},
			},
		],
	},
	{ kind: "assistant", text: "That file doesn't exist — nothing to delete.", id: "a4" },
];

/** A tool output well past the 8000-char truncation limit. */
export const longOutputFixture: DisplayItem[] = [
	{ kind: "user", text: "Dump the build log.", id: "u5" },
	{
		kind: "activity",
		key: "g-long-output",
		items: [
			{
				kind: "tool",
				entry: {
					toolUseId: "tool-log",
					name: "Read",
					input: { file_path: "/var/log/build.log" },
					result: { content: "line of build output\n".repeat(500), isError: false }, // ~10500 chars
				},
			},
		],
	},
	{ kind: "assistant", text: "The log is attached above (truncated).", id: "a5" },
];

/** Several consecutive tool calls (plus a leading thinking step) folded into one group. */
export const multiToolFixture: DisplayItem[] = [
	{ kind: "user", text: "Rename `foo` to `bar` in src/util.ts.", id: "u6" },
	{
		kind: "activity",
		key: "g-multi",
		items: [
			{ kind: "thinking", text: "I'll read the file first, then apply the rename.", id: "t2" },
			{
				kind: "tool",
				entry: {
					toolUseId: "tool-read",
					name: "Read",
					input: { path: "src/util.ts" },
					result: { content: "export const foo = 1;\nconsole.log(foo);", isError: false },
				},
			},
			{
				kind: "tool",
				entry: {
					toolUseId: "tool-edit",
					name: "Edit",
					input: { path: "src/util.ts", old_string: "foo", new_string: "bar" },
					result: { content: "Updated src/util.ts", isError: false },
				},
			},
		],
	},
	{ kind: "assistant", text: "Renamed `foo` to `bar` in `src/util.ts`.", id: "a6" },
];

export const scenarios: ExportScenario[] = [
	{ name: "plain-qa", title: "Plain Q&A", items: plainQaFixture },
	{ name: "thinking", title: "Thinking blocks", items: thinkingFixture },
	{ name: "tool-success", title: "Successful tool call", items: successfulToolFixture },
	{ name: "tool-error", title: "Tool call error", items: errorToolFixture },
	{ name: "long-output", title: "Long tool output (truncated)", items: longOutputFixture },
	{ name: "multi-tool", title: "Multiple tool calls in one group", items: multiToolFixture },
	{
		name: "kitchen-sink",
		title: "Kitchen sink — every case together",
		items: [
			...plainQaFixture,
			...thinkingFixture,
			...successfulToolFixture,
			...errorToolFixture,
			...longOutputFixture,
			...multiToolFixture,
		],
	},
];

export const sampleMeta: ExportMeta = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	title: "Sample export walkthrough",
	model: "claude-sonnet-5",
	updatedAt: Date.parse("2026-08-18T08:41:01.332Z"),
};
