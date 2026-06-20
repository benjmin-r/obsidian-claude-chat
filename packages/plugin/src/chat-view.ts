import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { BridgeEvent } from "@occ/protocol";
import type ClaudeChatPlugin from "./main";
import { BridgeClient, type WsLike } from "./bridge-client";
import { MODEL_OPTIONS } from "./settings-types";
import { applyEvent, appendUserMessage, clearPermission, initialState, setConnection, type ChatState, type ToolEntry } from "./view-model";

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

	private connIconEl!: HTMLElement;
	private activityIconEl!: HTMLElement;
	private modelLabelEl!: HTMLElement;
	private selectedModel: string;
	private messagesEl!: HTMLElement;
	private permissionEl!: HTMLElement;
	private todosEl!: HTMLElement;
	private pickerEl!: HTMLElement;
	private pickerOpen = false;
	private sessionsLoading = false;
	private sessionsLastOk = 0;
	private sessionsRefreshTimer: number | undefined;
	private inputEl!: HTMLTextAreaElement;
	private interruptBtn!: HTMLButtonElement;
	/** tool blocks the user has expanded, kept across re-renders. */
	private readonly expandedTools = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ClaudeChatPlugin
	) {
		super(leaf);
		this.selectedModel = plugin.settings.defaultModel;
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

		// Left → right: New, session picker, model. (Single row; never wraps.)
		const newBtn = toolbar.createEl("button", { cls: "occ-tool-btn" });
		setIcon(newBtn, "plus");
		newBtn.setAttr("aria-label", "New session");
		newBtn.addEventListener("click", () => this.startNewSession());

		const pickerBtn = toolbar.createEl("button", { cls: "occ-tool-btn" });
		setIcon(pickerBtn, "list");
		pickerBtn.setAttr("aria-label", "Resume a session");
		pickerBtn.addEventListener("click", () => this.togglePicker());

		const modelBtn = toolbar.createEl("button", { cls: "occ-model-btn" });
		this.modelLabelEl = modelBtn.createSpan({ cls: "occ-model-label" });
		setIcon(modelBtn.createSpan({ cls: "occ-model-caret" }), "chevron-down");
		modelBtn.setAttr("aria-label", "Choose the model for new sessions");
		modelBtn.addEventListener("click", (e) => this.openModelMenu(e));

		// Right-aligned status group: stop (only mid-turn), connection, activity.
		const status = toolbar.createDiv({ cls: "occ-status" });
		this.interruptBtn = status.createEl("button", { cls: "occ-tool-btn occ-stop" });
		setIcon(this.interruptBtn, "square");
		this.interruptBtn.setAttr("aria-label", "Stop the current turn");
		this.interruptBtn.addEventListener("click", () => {
			if (this.state.sessionId) this.client.interrupt(this.state.sessionId);
		});
		this.connIconEl = status.createSpan({ cls: "occ-status-icon" });
		this.connIconEl.addEventListener("click", () => this.openStatusLegend());
		this.activityIconEl = status.createSpan({ cls: "occ-status-icon" });
		this.activityIconEl.addEventListener("click", () => this.openStatusLegend());

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
		this.state = { ...initialState(this.selectedModel), connection: this.state.connection };
		this.client.newSession(this.selectedModel);
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
		this.state = { ...initialState(this.selectedModel), connection: this.state.connection };
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
			this.client.newSession(this.selectedModel);
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
		this.renderStatus();
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
			const isCurrent = !!this.state.sessionId && s.sessionId === this.state.sessionId;
			if (isCurrent) {
				item.addClass("occ-picker-current");
				item.setAttr("aria-current", "true");
			}
			const main = item.createDiv({ cls: "occ-picker-main" });
			const named = s.title && s.title.trim();
			const startedAgo = s.updatedAt ? relativeTime(Date.now() - s.updatedAt) : "just now";
			main.createSpan({ cls: "occ-picker-title", text: named || `New session — started ${startedAgo}` });
			const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
			const meta = [isCurrent ? "● current" : s.status, when].filter(Boolean).join(" · ");
			if (meta) main.createDiv({ cls: "occ-picker-meta", text: meta });
			main.addEventListener("click", () => this.resumeSession(s.sessionId));

			const label = named || `New session — started ${startedAgo}`;
			const rename = item.createEl("button", { cls: "occ-picker-rename" });
			setIcon(rename, "pencil");
			rename.setAttr("aria-label", "Rename session");
			rename.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openRename(s.sessionId, named || "");
			});

			const del = item.createEl("button", { cls: "occ-picker-delete" });
			setIcon(del, "trash-2");
			del.setAttr("aria-label", "Delete session");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				this.confirmDelete(s.sessionId, label);
			});
		}
	}

	private confirmDelete(sessionId: string, label: string): void {
		new ConfirmModal(
			this.app,
			"Delete session",
			`Permanently delete “${label}”? This removes the conversation from the server and can't be undone.`,
			"Delete",
			() => {
				this.client.deleteSession(sessionId);
				if (this.state.sessionId === sessionId) {
					// We deleted the session we were viewing — reset the transcript.
					this.pendingText = undefined;
					this.state = { ...initialState(this.selectedModel), connection: this.state.connection };
				}
				this.refreshSessions();
				this.render();
			}
		).open();
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

	private renderStatus(): void {
		const conn = this.state.connection;
		setIcon(this.connIconEl, conn === "connected" ? "wifi" : conn === "connecting" ? "loader" : "wifi-off");
		this.connIconEl.className = `occ-status-icon occ-conn-${conn}`;
		this.connIconEl.setAttr("aria-label", `Connection: ${conn}`);

		const mirroring = !!this.state.sessionId && !this.state.isWriter;
		let icon = "check";
		let cls = "idle";
		let label = "Idle — ready";
		if (mirroring) {
			[icon, cls, label] = ["eye", "mirroring", "Mirroring — read-only"];
		} else if (this.state.status === "awaiting_permission") {
			[icon, cls, label] = ["alert-triangle", "awaiting", "Awaiting your permission"];
		} else if (this.state.status === "working") {
			[icon, cls, label] = ["loader", "working", "Working…"];
		}
		setIcon(this.activityIconEl, icon);
		this.activityIconEl.className = `occ-status-icon occ-act-${cls}`;
		this.activityIconEl.setAttr("aria-label", label);

		// The stop button only matters mid-turn; reserve its slot (no layout jump).
		const working = this.state.status === "working";
		this.interruptBtn.style.visibility = working ? "visible" : "hidden";
		this.interruptBtn.disabled = !working;

		this.modelLabelEl.setText(MODEL_OPTIONS[this.selectedModel] ?? this.selectedModel);
	}

	private openModelMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const [value, label] of Object.entries(MODEL_OPTIONS)) {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(value === this.selectedModel)
					.onClick(() => {
						this.selectedModel = value;
						this.modelLabelEl.setText(label);
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private openStatusLegend(): void {
		new StatusLegendModal(this.app).open();
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
				const bubble = this.messagesEl.createDiv({ cls: "occ-bubble occ-user" });
				bubble.createDiv({ text: item.text });
				this.addMsgCopy(bubble, item.text);
			} else if (item.kind === "assistant") {
				const bubble = this.messagesEl.createDiv({ cls: "occ-bubble occ-assistant" });
				this.addMsgCopy(bubble, item.text);
				const content = bubble.createDiv({ cls: "occ-bubble-content" });
				// Obsidian's MarkdownRenderer already adds a native copy button to
				// each code block, so we don't add our own there.
				void MarkdownRenderer.render(this.app, item.text, content, "", this);
			} else if (item.kind === "thinking") {
				this.messagesEl.createDiv({ cls: "occ-thinking", text: item.text });
			} else {
				this.renderTool(item.entry);
			}
		}
	}

	/** Copy `text` to the clipboard with a brief confirmation. */
	private copyToClipboard(text: string): void {
		const clip = navigator.clipboard;
		if (!clip) {
			new Notice("Clipboard unavailable", 2000);
			return;
		}
		void clip.writeText(text).then(
			() => new Notice("Copied", 1200),
			() => new Notice("Copy failed", 2000)
		);
	}

	/** Add a small copy button to a message bubble (copies the whole message). */
	private addMsgCopy(bubble: HTMLElement, text: string): void {
		const btn = bubble.createEl("button", { cls: "occ-msg-copy" });
		setIcon(btn, "copy");
		btn.setAttr("aria-label", "Copy message");
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.copyToClipboard(text);
		});
	}


	private renderTool(entry: ToolEntry): void {
		const expanded = this.expandedTools.has(entry.toolUseId);
		const cls = entry.result?.isError ? "occ-tool occ-tool-error" : "occ-tool";
		const el = this.messagesEl.createDiv({ cls });

		// One-line, tappable summary.
		const header = el.createDiv({ cls: "occ-tool-header" });
		const chevron = header.createSpan({ cls: "occ-tool-chevron" });
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		header.createSpan({ cls: "occ-tool-name", text: `🔧 ${entry.name}` });
		const inputStr = typeof entry.input === "object" && entry.input ? JSON.stringify(entry.input) : "";
		if (inputStr) header.createSpan({ cls: "occ-tool-preview", text: inputStr });
		if (entry.result?.isError) header.createSpan({ cls: "occ-tool-badge", text: "error" });

		// Full detail, hidden until expanded.
		const body = el.createDiv({ cls: "occ-tool-body" });
		body.style.display = expanded ? "" : "none";
		if (inputStr) body.createEl("pre", { cls: "occ-tool-input", text: inputStr });
		if (entry.result) {
			const c = entry.result.content;
			body.createEl("pre", { text: c.length > 8000 ? c.slice(0, 8000) + "\n…(truncated)" : c });
		}

		header.addEventListener("click", () => {
			const open = !this.expandedTools.has(entry.toolUseId);
			if (open) this.expandedTools.add(entry.toolUseId);
			else this.expandedTools.delete(entry.toolUseId);
			body.style.display = open ? "" : "none";
			setIcon(chevron, open ? "chevron-down" : "chevron-right");
		});
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

/** Confirm/cancel modal for a destructive action. */
class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly body: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.heading });
		contentEl.createEl("p", { text: this.body });
		const row = contentEl.createDiv({ cls: "occ-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const confirm = row.createEl("button", { text: this.confirmText, cls: "mod-warning" });
		confirm.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Dismissable overlay documenting what each status icon means. */
const STATUS_LEGEND: ReadonlyArray<{ heading: string } | { icon: string; cls: string; desc: string }> = [
	{ heading: "Connection" },
	{ icon: "wifi", cls: "occ-conn-connected", desc: "Connected to the server" },
	{ icon: "loader", cls: "occ-conn-connecting", desc: "Connecting…" },
	{ icon: "wifi-off", cls: "occ-conn-disconnected", desc: "Disconnected" },
	{ heading: "Activity" },
	{ icon: "check", cls: "occ-act-idle", desc: "Idle — ready for your message" },
	{ icon: "loader", cls: "occ-act-working", desc: "Working — Claude is responding" },
	{ icon: "alert-triangle", cls: "occ-act-awaiting", desc: "Awaiting your permission for a destructive tool" },
	{ icon: "eye", cls: "occ-act-mirroring", desc: "Mirroring — another client is the writer; you're read-only" },
];

class StatusLegendModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Status icons" });
		for (const entry of STATUS_LEGEND) {
			if ("heading" in entry) {
				contentEl.createEl("h4", { text: entry.heading });
				continue;
			}
			const row = contentEl.createDiv({ cls: "occ-legend-row" });
			const ic = row.createSpan({ cls: `occ-status-icon ${entry.cls}` });
			setIcon(ic, entry.icon);
			row.createSpan({ text: entry.desc });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
