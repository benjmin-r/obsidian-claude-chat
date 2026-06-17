/**
 * Thin I/O shell around the Claude Agent SDK `query()`. This is the ONLY module
 * that imports the SDK; it is excluded from coverage and never loaded by unit
 * tests (the core takes `RunQuery` as an injected port).
 *
 * Auth: we pass NO apiKey and rely on the subscription session in ~/.claude.
 * `ANTHROPIC_API_KEY` must remain unset in the process env (see config.ts).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunQuery } from "./ports";

export const runQuery: RunQuery = (prompt, options) => {
	const q = query({
		// The SDK accepts an AsyncIterable<SDKUserMessage> as a streaming prompt.
		prompt: prompt as never,
		options: {
			cwd: options.cwd,
			model: options.model,
			permissionMode: "default", // route every tool through canUseTool
			includePartialMessages: true, // incremental text streaming
			canUseTool: options.canUseTool as never,
			...(options.resume ? { resume: options.resume } : {}),
		} as never,
	});
	return q as unknown as ReturnType<RunQuery>;
};
