import { parseClientMessage } from "../src/ws-transport";

describe("parseClientMessage", () => {
	it("parses valid client frames", () => {
		expect(parseClientMessage('{"type":"hello","token":"x"}')).toEqual({ type: "hello", token: "x" });
		expect(parseClientMessage('{"type":"list_sessions"}')).toEqual({ type: "list_sessions" });
		expect(parseClientMessage('{"type":"rename_session","sessionId":"s","title":"t"}')).toEqual({
			type: "rename_session",
			sessionId: "s",
			title: "t",
		});
		expect(parseClientMessage('{"type":"delete_session","sessionId":"s"}')).toEqual({
			type: "delete_session",
			sessionId: "s",
		});
	});

	it("rejects non-JSON", () => {
		expect(parseClientMessage("not json")).toBeNull();
		expect(parseClientMessage("")).toBeNull();
	});

	it("rejects non-objects and unknown types", () => {
		expect(parseClientMessage("42")).toBeNull();
		expect(parseClientMessage("null")).toBeNull();
		expect(parseClientMessage('{"type":"evil"}')).toBeNull();
		expect(parseClientMessage('{"no":"type"}')).toBeNull();
	});
});
