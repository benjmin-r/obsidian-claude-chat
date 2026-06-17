/**
 * Pure predicate deciding which tool invocations require explicit user
 * confirmation. Policy (locked in review): "auto-apply edits, confirm only
 * deletes". Reads, edits, writes and creates auto-allow; destructive shell
 * operations (deletes, overwrites, force-resets) route to the client.
 *
 * Conservative by design — when in doubt we ASK rather than silently destroy.
 * The set is intentionally small and explicit so it is easy to reason about and
 * extend (see PLAN "Open build-time decisions").
 */

/** Shell-command fragments that destroy or overwrite data. */
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	/\brm\b/, // remove files
	/\brmdir\b/, // remove directories
	/\bunlink\b/,
	/\bmv\b/, // move can clobber the destination
	/\bshred\b/,
	/\btruncate\b/,
	/\bdd\b/,
	/\bmkfs\S*/,
	/>\s*\/dev\/sd/, // writing straight to a block device
	/\bgit\s+reset\b[^\n]*--hard/,
	/\bgit\s+clean\b[^\n]*-[a-z]*f/,
	/\bgit\s+checkout\b[^\n]*--\s/,
	/\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b)/,
	/\bgit\s+branch\b[^\n]*\s-D\b/,
];

/** A single `>` truncating redirect (not `>>` append, not `>=`). */
function hasTruncatingRedirect(command: string): boolean {
	return /(^|[^>])>(?![>=])/.test(command);
}

/**
 * @returns true if `(toolName, input)` should prompt the user before running.
 */
export function isDestructive(toolName: string, input: unknown): boolean {
	if (toolName !== "Bash") {
		// Edit / Write / MultiEdit / NotebookEdit / Read / Glob / Grep, etc. auto-apply.
		return false;
	}
	const command = (input as { command?: unknown })?.command;
	if (typeof command !== "string" || command.length === 0) return false;
	if (hasTruncatingRedirect(command)) return true;
	return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(command));
}
