import { App } from "obsidian";
import { ClaudeChatSettingTab } from "../src/settings";
import { DEFAULT_SETTINGS, type ClaudeChatSettings } from "../src/settings-types";

function fakePlugin(settings: ClaudeChatSettings = { ...DEFAULT_SETTINGS }) {
	return { app: new App(), settings, saveSettings: jest.fn().mockResolvedValue(undefined) };
}

describe("DEFAULT_SETTINGS", () => {
	it("ships a tailnet ws url and empty token", () => {
		expect(DEFAULT_SETTINGS.serverUrl.startsWith("ws://")).toBe(true);
		expect(DEFAULT_SETTINGS.token).toBe("");
		expect(DEFAULT_SETTINGS.autoReconnect).toBe(true);
	});
});

describe("ClaudeChatSettingTab", () => {
	it("renders all fields including a password-masked token", () => {
		const plugin = fakePlugin();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tab = new ClaudeChatSettingTab(plugin.app, plugin as any);
		tab.display();
		const inputs = tab.containerEl.querySelectorAll("input");
		const selects = tab.containerEl.querySelectorAll("select");
		expect(inputs.length).toBeGreaterThanOrEqual(3);
		expect(selects.length).toBe(2); // model + default-mode dropdowns
		expect(tab.containerEl.querySelector('input[type="password"]')).not.toBeNull();
	});

	it("persists edits via saveSettings", async () => {
		const plugin = fakePlugin();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tab = new ClaudeChatSettingTab(plugin.app, plugin as any);
		tab.display();
		const urlInput = tab.containerEl.querySelector("input") as HTMLInputElement;
		urlInput.value = "ws://other:9000";
		urlInput.dispatchEvent(new Event("input"));
		await Promise.resolve();
		expect(plugin.settings.serverUrl).toBe("ws://other:9000");
		expect(plugin.saveSettings).toHaveBeenCalled();
	});
});
