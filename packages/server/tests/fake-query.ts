/**
 * A controllable fake of the SDK `query()` for unit tests: lets a test capture
 * the `canUseTool` callback the actor installed, emit SDK messages into the
 * actor's consume loop, and observe interrupts — with no real SDK.
 */
import { AsyncInputQueue } from "../src/async-queue";
import type { QueryHandle, QueryOptions, RunQuery, UserInputMessage } from "../src/ports";
import type { SdkMessage } from "@occ/protocol";

export interface FakeQuery {
	runQuery: RunQuery;
	emit(msg: SdkMessage): void;
	end(): void;
	options(): QueryOptions | undefined;
	prompt(): AsyncIterable<UserInputMessage> | undefined;
	interrupted(): boolean;
}

export function makeFakeQuery(): FakeQuery {
	const out = new AsyncInputQueue<SdkMessage>();
	let captured: QueryOptions | undefined;
	let capturedPrompt: AsyncIterable<UserInputMessage> | undefined;
	let didInterrupt = false;

	const runQuery: RunQuery = (prompt, options) => {
		captured = options;
		capturedPrompt = prompt;
		const handle: QueryHandle = {
			[Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
			interrupt: async () => {
				didInterrupt = true;
				out.close();
			},
		};
		return handle;
	};

	return {
		runQuery,
		emit: (msg) => out.push(msg),
		end: () => out.close(),
		options: () => captured,
		prompt: () => capturedPrompt,
		interrupted: () => didInterrupt,
	};
}

/** Let the microtask/macrotask queue drain so the consume loop processes emits. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
