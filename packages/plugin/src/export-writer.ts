/**
 * Vault-write shell for conversation export — the plugin's first vault-write
 * code. Kept Obsidian-type-light: `VaultWriter` is a minimal structural
 * interface `this.app.vault` satisfies at the call site, so this module is
 * fake-able in tests without importing "obsidian".
 */

import { exportFilePath, type ExportMeta } from "./export-shared";

export interface VaultFile {
	path: string;
}

/** The slice of Obsidian's `Vault` this module needs. */
export interface VaultWriter {
	getAbstractFileByPath(path: string): VaultFile | null;
	createFolder(path: string): Promise<unknown>;
	create(path: string, data: string): Promise<unknown>;
	modify(file: VaultFile, data: string): Promise<void>;
	read(file: VaultFile): Promise<string>;
}

function folderOf(filePath: string): string {
	const idx = filePath.lastIndexOf("/");
	return idx === -1 ? "" : filePath.slice(0, idx);
}

/**
 * Create every missing segment of `folderPath`, tolerating both an
 * already-existing folder (checked up front) and a create-time race with
 * another writer (caught here) — `Vault.createFolder` throws on either and
 * never creates parent chains on its own.
 */
async function ensureFolder(vault: VaultWriter, folderPath: string): Promise<void> {
	const segments = folderPath.split("/").filter(Boolean);
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		if (vault.getAbstractFileByPath(current)) continue;
		try {
			await vault.createFolder(current);
		} catch {
			// lost a create-time race with another writer — the folder exists either way.
		}
	}
}

/** Pull `session_id` out of our own frontmatter shape (`export-markdown.ts`'s `frontmatter()`). */
function parseSessionId(content: string): string | undefined {
	return content.match(/^session_id:\s*(\S+)\s*$/m)?.[1];
}

/**
 * Write a rendered export to the vault, resolving the filename collision the
 * date-led, id-less filename scheme (see TDL-20260820-010) can produce:
 * re-exporting the same session (matching `session_id` in the existing file's
 * frontmatter) overwrites in place; a different session sharing the same
 * date+title gets a numeric disambiguator suffix. Returns the path written to.
 */
export async function writeExportFile(
	vault: VaultWriter,
	base: string,
	groupByMonth: boolean,
	meta: ExportMeta,
	content: string
): Promise<string> {
	for (let suffix = 1; ; suffix++) {
		const path = exportFilePath(base, groupByMonth, meta.title, meta.updatedAt, "md", suffix);
		const existing = vault.getAbstractFileByPath(path);
		if (!existing) {
			await ensureFolder(vault, folderOf(path));
			await vault.create(path, content);
			return path;
		}
		const existingContent = await vault.read(existing);
		if (parseSessionId(existingContent) === meta.sessionId) {
			await vault.modify(existing, content);
			return path;
		}
	}
}
