/**
 * An async-iterable queue used as the streaming `prompt` for `query()`. Pushing
 * a user message resolves a pending `next()` (or buffers if none is waiting), so
 * the SDK query stays alive across turns and blocks awaiting the next input.
 */
export class AsyncInputQueue<T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly resolvers: Array<(r: IteratorResult<T>) => void> = [];
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const resolve = this.resolvers.shift();
		if (resolve) {
			resolve({ value: item, done: false });
		} else {
			this.queue.push(item);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		let resolve: ((r: IteratorResult<T>) => void) | undefined;
		while ((resolve = this.resolvers.shift())) {
			resolve({ value: undefined as never, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				const buffered = this.queue.shift();
				if (buffered !== undefined) {
					return Promise.resolve({ value: buffered, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined as never, done: true });
				}
				return new Promise((resolve) => this.resolvers.push(resolve));
			},
		};
	}
}
