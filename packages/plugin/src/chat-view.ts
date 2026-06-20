import { App, ItemView, MarkdownRenderer, Modal, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { BridgeEvent } from "@occ/protocol";
import type ClaudeChatPlugin from "./main";
import { BridgeClient, type WsLike } from "./bridge-client";
import { MODEL_OPTIONS } from "./settings-types";
import { applyEvent, appendUserMessage, clearPermission, initialState, setConnection, type ChatState } from "./view-model";

export const VIEW_TYPE_CLAUDE_CHAT = "claude-chat-view";

/** After this long without a successful refresh, the session list is flagged stale. */
const STALE_AFTER_MS = 60_000;

function relativeTime(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

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
	private pickerEl!: HTMLElement;
	private pickerOpen = false;
	private sessionsLoading = false;
	private sessionsLastOk = 0;
	private sessionsRefreshTimer: number | undefined;
	private inputEl!: HTMLTextAreaElement;
	private modelSelect!: HTMLSelectElement;
	private interruptBtn!: HTMLButtonElement;

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
		if (this.sessionsRefreshTimer !== undefined) window.clearTimeout(this.sessionsRefreshTimer);
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
		listBtn.setAttr("aria-label", "Resume a session");
		listBtn.addEventListener("click", () => this.togglePicker());

		this.interruptBtn = toolbar.createEl("button");
		setIcon(this.interruptBtn, "square");
		this.interruptBtn.setAttr("aria-label", "Stop the current turn");
		this.interruptBtn.addEventListener("click", () => {
			if (this.state.sessionId) this.client.interrupt(this.state.sessionId);
		});

		this.pickerEl = root.createDiv({ cls: "occ-picker" });
		this.pickerEl.style.display = "none";
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
		this.pickerOpen = false;
		this.state = { ...initialState(this.modelSelect.value), connection: this.state.connection };
		this.client.newSession(this.modelSelect.value);
		this.render();
	}

	private togglePicker(): void {
		this.pickerOpen = !this.pickerOpen;
		// Always fetch live data on open (every open fires a request, by design).
		if (this.pickerOpen) this.refreshSessions();
		this.renderPicker();
	}

	private refreshSessions(): void {
		if (this.sessionsRefreshTimer !== undefined) window.clearTimeout(this.sessionsRefreshTimer);
		if (!this.client || !this.client.isConnected()) {
			// Can't refresh; renderPicker shows the offline/stale note over last-known data.
			this.sessionsLoading = false;
			return;
		}
		this.sessionsLoading = true;
		this.client.listSessions();
		// If no `sessions_list` reply arrives, drop the spinner so the stale note shows.
		this.sessionsRefreshTimer = window.setTimeout(() => {
			this.sessionsLoading = false;
			this.sessionsRefreshTimer = undefined;
			this.renderPicker();
		}, 5000);
	}

	private resumeSession(sessionId: string): void {
		this.pickerOpen = false;
		this.pendingText = undefined;
		// Clear the current transcript; the resumed session's history replays in.
		this.state = { ...initialState(this.modelSelect.value), connection: this.state.connection };
		this.client.resumeSession(sessionId);
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
		if (event.type === "sessions_list") {
			this.sessionsLoading = false;
			this.sessionsLastOk = Date.now();
			if (this.sessionsRefreshTimer !== undefined) {
				window.clearTimeout(this.sessionsRefreshTimer);
				this.sessionsRefreshTimer = undefined;
			}
		}
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
		this.renderPicker();
		this.renderTodos();
		this.renderMessages();
		this.renderPermission();
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private renderPicker(): void {
		this.pickerEl.style.display = this.pickerOpen ? "" : "none";
		if (!this.pickerOpen) return;
		this.pickerEl.empty();

		const status = this.pickerEl.createDiv({ cls: "occ-picker-status" });
		status.setText(this.pickerStatusText());
		if (this.pickerStatusIsWarning()) status.addClass("occ-picker-stale");

		if (this.state.sessions.length === 0) {
			if (!this.sessionsLoading) this.pickerEl.createDiv({ cls: "occ-picker-empty", text: "No sessions found." });
			return;
		}
		for (const s of this.state.sessions) {
			const item = this.pickerEl.createDiv({ cls: "occ-picker-item" });
			const main = item.createDiv({ cls: "occ-picker-main" });
			main.createSpan({ cls: "occ-picker-title", text: (s.title && s.title.trim()) || s.sessionId });
			const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
			const meta = [s.status, when].filter(Boolean).join(" · ");
			if (meta) main.createDiv({ cls: "occ-picker-meta", text: meta });
			main.addEventListener("click", () => this.resumeSession(s.sessionId));

			const rename = item.createEl("button", { cls: "occ-picker-rename" });
			setIcon(rename, "pencil");
			rename.setAttr("aria-label", "Rename session");
			rename.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openRename(s.sessionId, (s.title && s.title.trim()) || "");
			});
		}
	}

	private openRename(sessionId: string, current: string): void {
		new RenameModal(this.app, current, (title) => {
			this.client.renameSession(sessionId, title);
			// The server pushes a refreshed sessions_list; nudge a refresh too.
			this.refreshSessions();
			this.renderPicker();
		}).open();
	}

	private pickerStatusIsWarning(): boolean {
		if (!this.client || !this.client.isConnected()) return true;
		if (this.sessionsLoading || !this.sessionsLastOk) return false;
		return Date.now() - this.sessionsLastOk > STALE_AFTER_MS;
	}

	private pickerStatusText(): string {
		const rel = this.sessionsLastOk ? relativeTime(Date.now() - this.sessionsLastOk) : "";
		if (!this.client || !this.client.isConnected()) {
			return this.sessionsLastOk ? `⚠ Offline — list may be stale (updated ${rel})` : "⚠ Offline — can't load sessions";
		}
		if (this.sessionsLoading) return this.sessionsLastOk ? `Refreshing… (updated ${rel})` : "Loading sessions…";
		if (!this.sessionsLastOk) return "";
		return Date.now() - this.sessionsLastOk > STALE_AFTER_MS ? `⚠ May be stale — updated ${rel}` : `Updated ${rel}`;
	}

	private renderBadges(): void {
		this.badgeEl.className = `occ-badge occ-${this.state.connection}`;
		this.badgeEl.setText(this.state.connection);
		const writer = this.state.sessionId ? (this.state.isWriter ? "" : " (mirroring)") : "";
		this.statusEl.className = `occ-badge occ-${this.state.status}`;
		this.statusEl.setText(this.state.status + writer);
		// The stop button only does something mid-turn; disable it otherwise.
		this.interruptBtn.disabled = this.state.status !== "working";
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

/** Small modal to set a session's title. */
class RenameModal extends Modal {
	constructor(
		app: App,
		private readonly current: string,
		private readonly onSubmit: (title: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Rename session" });
		const input = contentEl.createEl("input");
		input.type = "text";
		input.value = this.current;
		input.placeholder = "Session title";
		input.style.width = "100%";

		const submit = (): void => {
			const value = input.value.trim();
			if (value) this.onSubmit(value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		const row = contentEl.createDiv({ cls: "occ-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		row.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", submit);
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
