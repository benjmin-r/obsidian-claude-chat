import { ItemView, MarkdownRenderer, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { BridgeEvent } from "@occ/protocol";
import type ClaudeChatPlugin from "./main";
import { BridgeClient, type WsLike } from "./bridge-client";
import { MODEL_OPTIONS } from "./settings-types";
import { applyEvent, appendUserMessage, clearPermission, initialState, setConnection, type ChatState } from "./view-model";

export const VIEW_TYPE_CLAUDE_CHAT = "claude-chat-view";

/**
 * The sidebar chat view. Thin DOM layer over the pure `view-model` reducer and
 * the injectable `BridgeClient`; both of those hold the tested logic. Uses only
 * DOM + WebSocket (mobile-safe).
 */
export class ChatView extends ItemView {
	private state: ChatState;
	private client!: BridgeClient;
	private pendingText: string | undefined;

	private badgeEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private permissionEl!: HTMLElement;
	private todosEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private modelSelect!: HTMLSelectElement;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ClaudeChatPlugin
	) {
		super(leaf);
		this.state = initialState(plugin.settings.defaultModel);
	}

	getViewType(): string {
		return VIEW_TYPE_CLAUDE_CHAT;
	}

	getDisplayText(): string {
		return "Claude Chat";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.buildDom();
		this.client = new BridgeClient({
			url: this.plugin.settings.serverUrl,
			token: this.plugin.settings.token,
			autoReconnect: this.plugin.settings.autoReconnect,
			reconnectDelayMs: this.plugin.settings.reconnectDelayMs,
			createSocket: (url) => new WebSocket(url) as unknown as WsLike,
			onEvent: (event) => this.onEvent(event),
			onStateChange: (s) => {
				this.state = setConnection(this.state, s);
				this.render();
			},
		});
		this.client.connect();
		this.render();
	}

	async onClose(): Promise<void> {
		this.client?.disconnect();
	}

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("occ-chat");

		const toolbar = root.createDiv({ cls: "occ-toolbar" });
		this.badgeEl = toolbar.createSpan({ cls: "occ-badge" });
		this.statusEl = toolbar.createSpan({ cls: "occ-badge" });

		this.modelSelect = toolbar.createEl("select");
		for (const [value, label] of Object.entries(MODEL_OPTIONS)) {
			this.modelSelect.createEl("option", { text: label, value });
		}
		this.modelSelect.value = this.plugin.settings.defaultModel;

		const newBtn = toolbar.createEl("button", { text: "New" });
		newBtn.addEventListener("click", () => this.startNewSession());

		const listBtn = toolbar.createEl("button");
		setIcon(listBtn, "list");
		listBtn.setAttr("aria-label", "List sessions");
		listBtn.addEventListener("click", () => this.client.listSessions());

		const interruptBtn = toolbar.createEl("button");
		setIcon(interruptBtn, "square");
		interruptBtn.setAttr("aria-label", "Interrupt");
		interruptBtn.addEventListener("click", () => {
			if (this.state.sessionId) this.client.interrupt(this.state.sessionId);
		});

		this.todosEl = root.createEl("ul", { cls: "occ-todos" });
		this.messagesEl = root.createDiv({ cls: "occ-messages" });
		this.permissionEl = root.createDiv();

		const inputRow = root.createDiv({ cls: "occ-input-row" });
		this.inputEl = inputRow.createEl("textarea");
		this.inputEl.placeholder = "Message Claude…";
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendCurrent();
			}
		});
		const sendBtn = inputRow.createEl("button", { text: "Send", cls: "mod-cta" });
		sendBtn.addEventListener("click", () => this.sendCurrent());
	}

	private startNewSession(): void {
		this.state = { ...initialState(this.modelSelect.value), connection: this.state.connection };
		this.client.newSession(this.modelSelect.value);
		this.render();
	}

	private sendCurrent(): void {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		if (this.state.sessionId) {
			this.client.userMessage(this.state.sessionId, text);
			this.state = appendUserMessage(this.state, text);
		} else {
			// no session yet — open one and flush the text when it is ready.
			this.pendingText = text;
			this.client.newSession(this.modelSelect.value);
			this.state = appendUserMessage(this.state, text);
		}
		this.render();
	}

	private onEvent(event: BridgeEvent): void {
		this.state = applyEvent(this.state, event);
		if (event.type === "session_status" && this.pendingText && event.sessionId) {
			this.client.userMessage(event.sessionId, this.pendingText);
			this.pendingText = undefined;
		}
		if (event.type === "error") new Notice(`Claude: ${event.message}`, 5000);
		this.render();
	}

	private decide(toolUseId: string, allow: boolean): void {
		if (!this.state.sessionId) return;
		this.client.decide(this.state.sessionId, toolUseId, allow);
		this.state = clearPermission(this.state, toolUseId);
		this.render();
	}

	// -- rendering -----------------------------------------------------------

	private render(): void {
		this.renderBadges();
		this.renderTodos();
		this.renderMessages();
		this.renderPermission();
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private renderBadges(): void {
		this.badgeEl.className = `occ-badge occ-${this.state.connection}`;
		this.badgeEl.setText(this.state.connection);
		const writer = this.state.sessionId ? (this.state.isWriter ? "" : " (mirroring)") : "";
		this.statusEl.className = `occ-badge occ-${this.state.status}`;
		this.statusEl.setText(this.state.status + writer);
	}

	private renderTodos(): void {
		this.todosEl.empty();
		for (const todo of this.state.todos) {
			const mark = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○";
			this.todosEl.createEl("li", { text: `${mark} ${todo.content}` });
		}
	}

	private renderMessages(): void {
		this.messagesEl.empty();
		for (const item of this.state.items) {
			if (item.kind === "user") {
				this.messagesEl.createDiv({ cls: "occ-bubble occ-user", text: item.text });
			} else if (item.kind === "assistant") {
				const el = this.messagesEl.createDiv({ cls: "occ-bubble occ-assistant" });
				void MarkdownRenderer.render(this.app, item.text, el, "", this);
			} else if (item.kind === "thinking") {
				this.messagesEl.createDiv({ cls: "occ-thinking", text: item.text });
			} else {
				this.renderTool(item.entry);
			}
		}
	}

	private renderTool(entry: { name: string; input: unknown; result?: { content: string; isError: boolean } }): void {
		const cls = entry.result?.isError ? "occ-tool occ-tool-error" : "occ-tool";
		const el = this.messagesEl.createDiv({ cls });
		const summary = typeof entry.input === "object" && entry.input ? JSON.stringify(entry.input) : "";
		el.createDiv({ text: `🔧 ${entry.name} ${summary}`.trim() });
		if (entry.result) {
			const text = entry.result.content.length > 600 ? entry.result.content.slice(0, 600) + "…" : entry.result.content;
			el.createEl("pre", { text });
		}
	}

	private renderPermission(): void {
		this.permissionEl.empty();
		const req = this.state.pendingPermission;
		if (!req) return;
		const box = this.permissionEl.createDiv({ cls: "occ-permission" });
		box.createDiv({ text: `Allow destructive tool ${req.name}?` });
		box.createEl("pre", { text: JSON.stringify(req.input, null, 2) });
		const buttons = box.createDiv({ cls: "occ-permission-buttons" });
		const allow = buttons.createEl("button", { text: "Allow", cls: "mod-warning" });
		allow.addEventListener("click", () => this.decide(req.toolUseId, true));
		const deny = buttons.createEl("button", { text: "Deny", cls: "mod-cta" });
		deny.addEventListener("click", () => this.decide(req.toolUseId, false));
	}
}
