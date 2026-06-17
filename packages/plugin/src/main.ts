import { Plugin } from "obsidian";
import { ChatView, VIEW_TYPE_CLAUDE_CHAT } from "./chat-view";
import { ClaudeChatSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type ClaudeChatSettings } from "./settings-types";

export default class ClaudeChatPlugin extends Plugin {
	settings!: ClaudeChatSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CLAUDE_CHAT, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon("message-square", "Open Claude chat", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-claude-chat",
			name: "Open Claude chat",
			callback: () => void this.activateView(),
		});

		this.addSettingTab(new ClaudeChatSettingTab(this.app, this));
	}

	onunload(): void {
		// Obsidian detaches the leaves; the view's onClose disconnects the socket.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Open (or reveal) the chat view in the right sidebar. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]!);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_CLAUDE_CHAT, active: true });
		await workspace.revealLeaf(leaf);
	}
}
