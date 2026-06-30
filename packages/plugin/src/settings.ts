import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeChatPlugin from "./main";
import { MODEL_OPTIONS, PERMISSION_MODE_OPTIONS } from "./settings-types";
import type { PermissionMode } from "@occ/protocol";

/**
 * Settings tab. Every field is rendered on all platforms (no desktop-only
 * gating) so mobile users can configure the server URL and token.
 */
export class ClaudeChatSettingTab extends PluginSettingTab {
	plugin: ClaudeChatPlugin;

	constructor(app: App, plugin: ClaudeChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// No top heading: Obsidian already renders the plugin name as the tab
		// title, and a single-section tab needs no extra heading.
		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("ws:// address of the Claude SDK server on your tailnet, including port.")
			.addText((text) =>
				text
					.setPlaceholder("ws://host.tailnet.ts.net:8765")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bearer token")
			.setDesc("Must match OCC_TOKEN on the server.")
			.addText((text) => {
				text.setPlaceholder("token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Default model")
			.setDesc("Model used when starting a new session.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(MODEL_OPTIONS)) dropdown.addOption(value, label);
				dropdown.setValue(this.plugin.settings.defaultModel).onChange(async (value) => {
					this.plugin.settings.defaultModel = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Default mode")
			.setDesc("Permission mode applied to new sessions. Change it per-chat from the toolbar mode picker.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(PERMISSION_MODE_OPTIONS)) dropdown.addOption(value, label);
				dropdown
					.setValue(this.plugin.settings.defaultPermissionMode)
					.onChange(async (value) => {
						this.plugin.settings.defaultPermissionMode = value as PermissionMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-reconnect")
			.setDesc("Reconnect automatically when the connection drops.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoReconnect).onChange(async (value) => {
					this.plugin.settings.autoReconnect = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reconnect delay (ms)")
			.setDesc("Base backoff between reconnect attempts.")
			.addText((text) =>
				text
					.setPlaceholder("1500")
					.setValue(String(this.plugin.settings.reconnectDelayMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						const valid = !Number.isNaN(n) && n >= 100;
						if (valid) {
							this.plugin.settings.reconnectDelayMs = n;
							await this.plugin.saveSettings();
						}
						text.inputEl.toggleClass("occ-input-invalid", !valid);
					})
			);

		new Setting(containerEl)
			.setName("Keyboard debug panel")
			.setDesc(
				"Show a 'Copy KB' button that copies an on-screen-keyboard layout report to the clipboard. For diagnosing mobile keyboard/layout issues. Reopen the chat view after changing."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugKeyboardPanel).onChange(async (value) => {
					this.plugin.settings.debugKeyboardPanel = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
