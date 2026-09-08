/**
 * Standing dev tool (kept permanently, per plan) that renders the export
 * fixtures through `renderMarkdown` and writes the result into a real vault
 * folder for visual review in Obsidian — no server or live SDK session
 * required, since the renderer is pure. Run via `npm run export:preview` (see
 * package.json).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportFilePath, type ExportMeta } from "../src/export-shared";
import { renderMarkdown } from "../src/export-markdown";
import { scenarios } from "../tests/fixtures/export-fixtures";

const VAULT_ROOT = path.join(os.homedir(), "vaults", "benjamin");
const EXPORT_FOLDER = "Claude Conversations";

async function writeSample(meta: ExportMeta, content: string): Promise<void> {
	// Filename date is the session's start (first message), not last activity — see export-shared.ts.
	const relPath = exportFilePath(EXPORT_FOLDER, false, meta.title, meta.createdAt ?? meta.updatedAt, "md");
	const fullPath = path.join(VAULT_ROOT, relPath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
	console.log(`  ${fullPath}`);
}

async function main(): Promise<void> {
	console.log(`Rendering ${scenarios.length} export scenarios into ${path.join(VAULT_ROOT, EXPORT_FOLDER)}\n`);
	const now = Date.now();
	for (const scenario of scenarios) {
		const meta: ExportMeta = {
			sessionId: `preview-${scenario.name}`,
			title: scenario.title,
			model: "claude-sonnet-5",
			createdAt: now - 2 * 60 * 60 * 1000, // conversation "started" 2h ago
			updatedAt: now,
		};
		await writeSample(meta, renderMarkdown(scenario.items, meta));
	}
	console.log(`\nWrote ${scenarios.length} files.`);
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
