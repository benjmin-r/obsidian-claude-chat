/**
 * Standing dev tool (kept permanently, per plan) that renders the export
 * fixtures through `renderMarkdown`/`renderHtml` and writes the result into a
 * real vault folder for visual review in Obsidian — no server or live SDK
 * session required, since the renderers are pure. Run via `npm run
 * export:preview` (see package.json).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportFilePath, type ExportMeta } from "../src/export-shared";
import { renderHtml } from "../src/export-html";
import { renderMarkdown } from "../src/export-markdown";
import { scenarios, sampleTimestamps } from "../tests/fixtures/export-fixtures";

const VAULT_ROOT = path.join(os.homedir(), "vaults", "benjamin");
const EXPORT_FOLDER = "Claude Conversations";

async function writeSample(meta: ExportMeta, ext: "md" | "html", content: string): Promise<void> {
	const relPath = exportFilePath(EXPORT_FOLDER, false, meta.title, meta.updatedAt, ext);
	const fullPath = path.join(VAULT_ROOT, relPath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
	console.log(`  ${fullPath}`);
}

async function main(): Promise<void> {
	console.log(`Rendering ${scenarios.length} export scenarios into ${path.join(VAULT_ROOT, EXPORT_FOLDER)}\n`);
	for (const scenario of scenarios) {
		const meta: ExportMeta = {
			sessionId: `preview-${scenario.name}`,
			title: scenario.title,
			model: "claude-sonnet-5",
			updatedAt: Date.now(),
		};
		await writeSample(meta, "md", renderMarkdown(scenario.items, meta, sampleTimestamps));
		await writeSample(meta, "html", renderHtml(scenario.items, meta, sampleTimestamps));
	}
	console.log(`\nWrote ${scenarios.length * 2} files.`);
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
