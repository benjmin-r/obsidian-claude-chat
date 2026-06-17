import ClaudeChatPlugin from "../src/main";
import { VIEW_TYPE_CLAUDE_CHAT } from "../src/chat-view";

describe("ClaudeChatPlugin", () => {
	it("registers the view, commands, ribbon and settings on load", async () => {
		const plugin = new ClaudeChatPlugin();
		await plugin.onload();
		expect(plugin.registerView).toHaveBeenCalledWith(VIEW_TYPE_CLAUDE_CHAT, expect.any(Function));
		expect(plugin.addCommand).toHaveBeenCalled();
		expect(plugin.addRibbonIcon).toHaveBeenCalled();
		expect(plugin.addSettingTab).toHaveBeenCalled();
		expect(plugin.settings.defaultModel).toBe("claude-opus-4-8");
	});

	it("opens a new right-sidebar leaf when none exists", async () => {
		const plugin = new ClaudeChatPlugin();
		await plugin.onload();
		await plugin.activateView();
		expect(plugin.app.workspace.getRightLeaf).toHaveBeenCalled();
	});

	it("reveals an existing leaf instead of creating one", async () => {
		const plugin = new ClaudeChatPlugin();
		await plugin.onload();
		const leaf = { setViewState: jest.fn() };
		(plugin.app.workspace.getLeavesOfType as jest.Mock).mockReturnValueOnce([leaf]);
		await plugin.activateView();
		expect(plugin.app.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
	});
});
