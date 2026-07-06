import { Notice, Plugin } from "obsidian";
import { ChatView, VIEW_TYPE_CLAUDE_CHAT } from "./chat-view";
import { ConversationSuggest, insertConversationLink } from "./link-insert";
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

		this.addCommand({
			id: "open-claude-chat-tab",
			name: "Open Claude chat in tab",
			callback: () => void this.openInTab(),
		});

		// Link to conversations from notes: `[title](obsidian://occ-chat?session=<id>)`.
		this.addCommand({
			id: "insert-conversation-link",
			name: "Insert link to a Claude conversation",
			editorCallback: (editor) => void insertConversationLink(this, editor),
		});
		// Inline `/occ` autocomplete in the editor inserts the same link.
		this.registerEditorSuggest(new ConversationSuggest(this));
		// Route occ-chat:// links (from notes) to the chat view, opening the session.
		this.registerObsidianProtocolHandler("occ-chat", (params) => void this.openSessionFromLink(params.session));

		this.addSettingTab(new ClaudeChatSettingTab(this.app, this));
	}

	/** Open the chat view and switch it to `sessionId` (from an occ-chat:// link). */
	async openSessionFromLink(sessionId?: string): Promise<void> {
		if (!sessionId) {
			new Notice("Claude Chat: link is missing a session id.");
			return;
		}
		await this.activateView();
		const view = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT)
			.map((leaf) => leaf.view)
			.find((v): v is ChatView => v instanceof ChatView);
		if (view) view.openSession(sessionId);
		else new Notice("Claude Chat: couldn't open the chat view.");
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

	/** Apply the connection-debug-panel setting to all open chat views (live toggle). */
	refreshConnDebugPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT)) {
			if (leaf.view instanceof ChatView) leaf.view.syncConnDebugPanel();
		}
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

	/**
	 * Open a NEW, independent chat in a main-area tab. Always creates a fresh tab
	 * (never reuses one), so multiple parallel chats — each its own ChatView,
	 * WebSocket and session — can run side by side.
	 */
	async openInTab(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_CLAUDE_CHAT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
