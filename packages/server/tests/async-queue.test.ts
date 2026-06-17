import { AsyncInputQueue } from "../src/async-queue";

describe("AsyncInputQueue", () => {
	it("delivers buffered items in order", async () => {
		const q = new AsyncInputQueue<number>();
		q.push(1);
		q.push(2);
		const it = q[Symbol.asyncIterator]();
		expect(await it.next()).toEqual({ value: 1, done: false });
		expect(await it.next()).toEqual({ value: 2, done: false });
	});

	it("resolves a pending next() when an item arrives later", async () => {
		const q = new AsyncInputQueue<string>();
		const it = q[Symbol.asyncIterator]();
		const pending = it.next();
		q.push("hi");
		expect(await pending).toEqual({ value: "hi", done: false });
	});

	it("closes pending and future reads", async () => {
		const q = new AsyncInputQueue<number>();
		const it = q[Symbol.asyncIterator]();
		const pending = it.next();
		q.close();
		expect(await pending).toEqual({ value: undefined, done: true });
		expect(await it.next()).toEqual({ value: undefined, done: true });
		q.push(5); // ignored after close
		expect(await it.next()).toEqual({ value: undefined, done: true });
	});
});
