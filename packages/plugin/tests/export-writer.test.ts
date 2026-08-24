import { writeExportFile, type VaultFile, type VaultWriter } from "../src/export-writer";
import type { ExportMeta } from "../src/export-shared";

function makeFakeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const folderCreateAttempts: string[] = [];

	const vault: VaultWriter = {
		getAbstractFileByPath: (path: string): VaultFile | null => {
			if (files.has(path) || folders.has(path)) return { path };
			return null;
		},
		createFolder: async (path: string) => {
			folderCreateAttempts.push(path);
			if (folders.has(path)) throw new Error("Folder already exists.");
			folders.add(path);
		},
		create: async (path: string, data: string) => {
			files.set(path, data);
			return { path };
		},
		modify: async (file: VaultFile, data: string) => {
			files.set(file.path, data);
		},
		read: async (file: VaultFile) => files.get(file.path) ?? "",
	};

	return { vault, files, folders, folderCreateAttempts };
}

const updatedAt = Date.parse("2026-08-18T08:41:01.332Z");

function makeMeta(sessionId: string): ExportMeta {
	return { sessionId, title: "My Chat", model: "claude-sonnet-5", updatedAt };
}

describe("writeExportFile", () => {
	it("creates every missing folder segment before writing a new file", async () => {
		const { vault, folders, files } = makeFakeVault();
		const path = await writeExportFile(vault, "Notes/Claude Conversations", false, makeMeta("s1"), "content");
		expect(path).toBe("Notes/Claude Conversations/20260818 - My Chat.md");
		expect(folders.has("Notes")).toBe(true);
		expect(folders.has("Notes/Claude Conversations")).toBe(true);
		expect(files.get(path)).toBe("content");
	});

	it("creates the YYYY-MM subfolder when grouping by month", async () => {
		const { vault, folders } = makeFakeVault();
		const path = await writeExportFile(vault, "Claude Conversations", true, makeMeta("s1"), "content");
		expect(path).toBe("Claude Conversations/2026-08/20260818 - My Chat.md");
		expect(folders.has("Claude Conversations")).toBe(true);
		expect(folders.has("Claude Conversations/2026-08")).toBe(true);
	});

	it("skips createFolder for a segment that already exists", async () => {
		const { vault, folders, folderCreateAttempts } = makeFakeVault();
		folders.add("Claude Conversations");
		await writeExportFile(vault, "Claude Conversations", false, makeMeta("s1"), "content");
		expect(folderCreateAttempts).toEqual([]);
	});

	it("tolerates a create-time race on an already-existing folder", async () => {
		const { vault, files } = makeFakeVault();
		vault.createFolder = async () => {
			throw new Error("Folder already exists.");
		};
		const path = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s1"), "content");
		expect(files.get(path)).toBe("content");
	});

	it("overwrites via modify when the existing file's frontmatter session_id matches", async () => {
		const { vault, files } = makeFakeVault();
		const path = "Claude Conversations/20260818 - My Chat.md";
		files.set(path, "---\nsession_id: s1\nmodel: claude-sonnet-5\n---\n\nold content");
		const result = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s1"), "new content");
		expect(result).toBe(path);
		expect(files.get(path)).toBe("new content");
	});

	it("appends a numeric suffix when the existing file belongs to a different session", async () => {
		const { vault, files } = makeFakeVault();
		files.set("Claude Conversations/20260818 - My Chat.md", "---\nsession_id: s1\n---\n\nother session");
		const path = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s2"), "content");
		expect(path).toBe("Claude Conversations/20260818 - My Chat (2).md");
		expect(files.get(path)).toBe("content");
	});

	it("keeps incrementing the suffix past multiple colliding sessions", async () => {
		const { vault, files } = makeFakeVault();
		files.set("Claude Conversations/20260818 - My Chat.md", "---\nsession_id: s1\n---\n\n");
		files.set("Claude Conversations/20260818 - My Chat (2).md", "---\nsession_id: s2\n---\n\n");
		const path = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s3"), "content");
		expect(path).toBe("Claude Conversations/20260818 - My Chat (3).md");
	});

	it("treats unparseable frontmatter as a collision (suffix, not overwrite)", async () => {
		const { vault, files } = makeFakeVault();
		files.set("Claude Conversations/20260818 - My Chat.md", "not frontmatter at all");
		const path = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s1"), "content");
		expect(path).toBe("Claude Conversations/20260818 - My Chat (2).md");
	});

	it("dates the filename by the session's start (createdAt), not its last activity (updatedAt)", async () => {
		const { vault } = makeFakeVault();
		const meta: ExportMeta = {
			sessionId: "s1",
			title: "My Chat",
			model: "claude-sonnet-5",
			createdAt: Date.parse("2026-08-01T09:00:00.000Z"), // conversation started here
			updatedAt, // but was last touched on 2026-08-18
		};
		const path = await writeExportFile(vault, "Claude Conversations", false, meta, "content");
		expect(path).toBe("Claude Conversations/20260801 - My Chat.md");
	});

	it("falls back to updatedAt for the filename date when createdAt is unknown", async () => {
		const { vault } = makeFakeVault();
		const path = await writeExportFile(vault, "Claude Conversations", false, makeMeta("s1"), "content");
		expect(path).toBe("Claude Conversations/20260818 - My Chat.md");
	});
});
