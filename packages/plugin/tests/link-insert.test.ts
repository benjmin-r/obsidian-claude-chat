import type { SessionSummary } from "@occ/protocol";
import { conversationLinkMarkdown, matchOccTrigger, occChatUri, sessionLabel } from "../src/link-insert";

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
	sessionId: "s1",
	model: "claude-opus-4-8",
	status: "idle",
	cwd: "/v",
	...over,
});

describe("occChatUri", () => {
	it("builds a routable session URI", () => {
		expect(occChatUri("abc-123")).toBe("obsidian://occ-chat?session=abc-123");
	});
	it("url-encodes the id and adds an optional message anchor", () => {
		expect(occChatUri("a b/c", "m 1")).toBe("obsidian://occ-chat?session=a%20b%2Fc&msg=m%201");
	});
});

describe("sessionLabel", () => {
	it("uses the title when present, trimmed", () => {
		expect(sessionLabel(session({ title: "  My chat " }))).toBe("My chat");
	});
	it("falls back for an untitled or blank session", () => {
		expect(sessionLabel(session({ title: "   " }))).toBe("New Claude session");
		expect(sessionLabel(session({ title: undefined }))).toBe("New Claude session");
	});
});

describe("conversationLinkMarkdown", () => {
	it("renders a markdown link to the session", () => {
		expect(conversationLinkMarkdown(session({ sessionId: "xyz", title: "Notes review" }))).toBe(
			"[Notes review](obsidian://occ-chat?session=xyz)"
		);
	});
});

describe("matchOccTrigger", () => {
	it("fires on /occ at line start with no query", () => {
		expect(matchOccTrigger("/occ")).toEqual({ query: "", startCh: 0 });
	});
	it("captures the query after /occ", () => {
		expect(matchOccTrigger("see /occ notes")).toEqual({ query: "notes", startCh: 4 });
	});
	it("fires only at a word boundary (not mid-path)", () => {
		expect(matchOccTrigger("foo/occ")).toBeNull();
		expect(matchOccTrigger("path/occ bar")).toBeNull();
	});
	it("does not fire without the trigger or once a slash follows", () => {
		expect(matchOccTrigger("just some text")).toBeNull();
		expect(matchOccTrigger("/occ notes/more")).toBeNull(); // query can't contain a slash
	});
});
