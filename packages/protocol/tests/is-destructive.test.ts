import { isDestructive } from "../src/is-destructive";

describe("isDestructive", () => {
	it("auto-allows non-Bash tools", () => {
		expect(isDestructive("Edit", { file_path: "/x", old_string: "a", new_string: "b" })).toBe(false);
		expect(isDestructive("Write", { file_path: "/x", content: "hi" })).toBe(false);
		expect(isDestructive("Read", { file_path: "/x" })).toBe(false);
		expect(isDestructive("MultiEdit", {})).toBe(false);
		expect(isDestructive("Glob", { pattern: "**/*" })).toBe(false);
	});

	it("auto-allows read-only Bash", () => {
		expect(isDestructive("Bash", { command: "ls -la" })).toBe(false);
		expect(isDestructive("Bash", { command: "cat notes.md" })).toBe(false);
		expect(isDestructive("Bash", { command: "echo hi >> log.txt" })).toBe(false); // append, not truncate
		expect(isDestructive("Bash", { command: "grep -rn foo ." })).toBe(false);
	});

	it("flags deletes and overwrites", () => {
		expect(isDestructive("Bash", { command: "rm -rf build" })).toBe(true);
		expect(isDestructive("Bash", { command: "rmdir tmp" })).toBe(true);
		expect(isDestructive("Bash", { command: "mv a.md b.md" })).toBe(true);
		expect(isDestructive("Bash", { command: "shred secret" })).toBe(true);
		expect(isDestructive("Bash", { command: "truncate -s0 f" })).toBe(true);
	});

	it("flags truncating redirects but not appends or fd redirects to >>", () => {
		expect(isDestructive("Bash", { command: "echo x > file.txt" })).toBe(true);
		expect(isDestructive("Bash", { command: "cmd 2> err.log" })).toBe(true);
		expect(isDestructive("Bash", { command: "echo x >> file.txt" })).toBe(false);
	});

	it("flags destructive git operations", () => {
		expect(isDestructive("Bash", { command: "git reset --hard HEAD~1" })).toBe(true);
		expect(isDestructive("Bash", { command: "git clean -fd" })).toBe(true);
		expect(isDestructive("Bash", { command: "git push origin main --force" })).toBe(true);
		expect(isDestructive("Bash", { command: "git push -f" })).toBe(true);
		expect(isDestructive("Bash", { command: "git branch -D feature" })).toBe(true);
		expect(isDestructive("Bash", { command: "git status" })).toBe(false);
		expect(isDestructive("Bash", { command: "git push origin main" })).toBe(false);
	});

	it("does not false-positive on words containing 'rm'", () => {
		expect(isDestructive("Bash", { command: "echo alarm" })).toBe(false);
		expect(isDestructive("Bash", { command: "node confirm.js" })).toBe(false);
	});

	it("handles missing / non-string commands defensively", () => {
		expect(isDestructive("Bash", {})).toBe(false);
		expect(isDestructive("Bash", { command: "" })).toBe(false);
		expect(isDestructive("Bash", { command: 42 })).toBe(false);
		expect(isDestructive("Bash", null)).toBe(false);
	});
});
