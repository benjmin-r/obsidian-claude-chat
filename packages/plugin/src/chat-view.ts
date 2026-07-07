import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import type { BridgeEvent, PermissionMode } from "@occ/protocol";
import type ClaudeChatPlugin from "./main";
import { BridgeClient, type WsLike } from "./bridge-client";
import { DebugLog } from "./debug-log";
import { FileSuggest } from "./file-suggest";
import { conversationLinkFromParts } from "./link-insert";
import { MODEL_OPTIONS } from "./settings-types";
import {
	applyEvent,
	appendUserMessage,
	clearPermission,
	initialState,
	setConnection,
	type ChatState,
	type ConnectionState,
	type ToolEntry,
} from "./view-model";

export const VIEW_TYPE_CLAUDE_CHAT = "claude-chat-view";

/** After this long without a successful refresh, the session list is flagged stale. */
const STALE_AFTER_MS = 60_000;
/** localStorage key for the unsent input draft (survives view reloads). */
const DRAFT_KEY = "occ-chat-draft";

/** Agent permission modes offered in the toolbar picker. */
const PERMISSION_MODES: ReadonlyArray<{ mode: PermissionMode; label: string; icon: string }> = [
	{ mode: "default", label: "Confirm destructive actions", icon: "shield" },
	{ mode: "acceptEdits", label: "Auto-accept edits", icon: "pencil" },
	{ mode: "auto", label: "Auto — model decides", icon: "sparkles" },
];

/** Human-friendly text for a permission request's input (the bash command, or JSON). */
function permissionInputText(input: unknown): string {
	const cmd = (input as { command?: unknown })?.command;
	return typeof cmd === "string" ? cmd : JSON.stringify(input, null, 2);
}

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
	/** session to open once the socket is ready (set by openSession before connect). */
	private pendingOpenSession: string | undefined;
	/** message a deep link wants to scroll to; paginate older until it's loaded. */
	private pendingScrollTo: string | undefined;
	/** true while a load_older requested by the deep-link resolver is in flight. */
	private deepLinkLoading = false;
	/** last text dispatched to the server; used to roll back if the server blocks it. */
	private lastSentText: string | undefined;

	private connIconEl!: HTMLElement;
	private activityIconEl!: HTMLElement;
	private costEl!: HTMLElement;
	private modelLabelEl!: HTMLElement;
	private modeBtn!: HTMLButtonElement;
	private reloadBtn!: HTMLButtonElement;
	private actionsBtn!: HTMLButtonElement;
	private selectedModel: string;
	/** desired permission mode for new sessions; applied once a session starts. */
	private desiredMode: PermissionMode;
	private applyDesiredMode = false;
	private messagesEl!: HTMLElement;
	private messagesInnerEl!: HTMLElement;
	private resizeObserver?: ResizeObserver;
	private scrollPillEl!: HTMLElement;
	private permissionEl!: HTMLElement;
	private activityBannerEl!: HTMLElement;
	private todosEl!: HTMLElement;
	private pickerEl!: HTMLElement;
	private pickerOpen = false;
	private sessionsLoading = false;
	private sessionsLastOk = 0;
	private sessionsRefreshTimer: number | undefined;
	private inputEl!: HTMLTextAreaElement;
	private inputRowEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	/** `@`-mention file picker over the composer (see file-suggest.ts). */
	private fileSuggest?: FileSuggest;
	/** tool blocks the user has expanded, kept across re-renders. */
	private readonly expandedTools = new Set<string>();
	/** set when an older-history page was just prepended, to keep the viewport stable. */
	private prependAdjust: { prevHeight: number; prevTop: number } | undefined;
	/** true while we should keep pinned to the bottom (re-scroll as async markdown grows). */
	private stickBottom = true;
	private lastScrollTop = 0;
	/** the current session's title, and the derived tab header text. */
	private currentTitle: string | undefined;
	private tabTitle = "New Session";

	// Connection-debug panel state (gated behind the debugConnectionPanel setting).
	private dlog?: DebugLog;
	private connDebugEl?: HTMLElement;
	private connDebugCopyBtn?: HTMLButtonElement;

	// On-screen-keyboard debug panel state (gated behind the debugKeyboardPanel setting).
	private kbDebugEl?: HTMLElement;
	private kbDebugTimer?: number;
	private kbLog: string[] = [];
	private kbHistory: string[] = [];
	private kbStartMs = 0;
	private kbLastHeight = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ClaudeChatPlugin
	) {
		super(leaf);
		this.selectedModel = plugin.settings.defaultModel;
		this.desiredMode = plugin.settings.defaultPermissionMode;
		this.state = initialState(plugin.settings.defaultModel);
	}

	getViewType(): string {
		return VIEW_TYPE_CLAUDE_CHAT;
	}

	getDisplayText(): string {
		return this.tabTitle;
	}

	/**
	 * The loaded session's name for the view/tab header: its title, or "New Session"
	 * for a new/empty/untitled session. Falls back to the picker list's title when
	 * `currentTitle` hasn't been set on this open path (e.g. attach-on-reconnect).
	 */
	private currentSessionName(): string {
		if (!this.state.sessionId) return "New Session";
		const stored = this.state.sessions.find((s) => s.sessionId === this.state.sessionId)?.title?.trim();
		return this.currentTitle?.trim() || stored || "New Session";
	}

	/** Reflect the loaded session's name in the view header + tab title. */
	private updateTabTitle(): void {
		const display = this.currentSessionName();
		if (display === this.tabTitle) return;
		this.tabTitle = display;
		// Refreshes the TAB header (getDisplayText).
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		// updateHeader doesn't refresh the INLINE view-header title in this Obsidian
		// version, so set that element directly (main-area leaves only; sidebars omit it).
		(this.containerEl.querySelector(".view-header-title") as HTMLElement | null)?.setText(display);
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.buildDom();
		// The iPhone navbar inset (styles.css) only applies to a main-area leaf, not a
		// sidebar (which has its own bottom toolbar). Re-evaluate if the leaf is moved.
		this.updateLeafLocationClass();
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateLeafLocationClass()));
		// Connection-debug logger (gated). Persists to localStorage so the log survives
		// the view teardown/recreate that backgrounding causes. Created before the client
		// so the very first connect() is captured.
		if (this.plugin.settings.debugConnectionPanel) {
			this.dlog = new DebugLog({
				store: window.localStorage,
				onChange: () => this.renderConnDebug(),
			});
			this.dlog.log("view", "onOpen");
		} else {
			// Panel off: drop any stale log left in localStorage from a previous debug run.
			DebugLog.purge(window.localStorage);
		}

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
			// Always forward; a no-op until the panel is enabled (this.dlog set), so the
			// setting can be toggled live without recreating the client.
			onDebug: (tag, msg) => this.dlog?.log(tag, msg),
		});
		if (this.dlog) this.mountConnDebug();
		this.client.connect();

		// Mobile-WS recovery: when the app returns to the foreground the OS has often
		// silently killed the socket (and suspended our reconnect timers). Force a
		// reconnect on visibility/focus if we're no longer connected.
		const recover = (src: string) => (): void => {
			this.dlog?.log("view", `${src} hidden=${document.hidden} connected=${this.client?.isConnected() ?? false}`);
			if (!document.hidden) this.client?.checkAlive();
		};
		this.registerDomEvent(document, "visibilitychange", recover("visibilitychange"));
		this.registerDomEvent(window, "focus", recover("focus"));
		this.registerDomEvent(window, "online", recover("online"));

		// Keep Escape inside the view. Obsidian's global Escape hotkey would otherwise
		// switch tabs / focus the editor; capture it at the view root so it never reaches
		// that handler. Menus and Modals are rendered outside contentEl, so their own
		// Escape handling is unaffected. When the @-mention popover is open, Escape just
		// dismisses it (and nothing else).
		this.registerDomEvent(
			this.contentEl,
			"keydown",
			(e) => {
				if (e.key !== "Escape") return;
				if (this.fileSuggest?.isOpen()) this.fileSuggest.close();
				e.preventDefault();
				e.stopPropagation();
			},
			{ capture: true }
		);

		// Resolve markdown links that point at vault files (both [[wikilinks]] and
		// [text](relative/path.md)) and open them in Obsidian; let real URLs open normally.
		this.registerDomEvent(this.messagesInnerEl, "click", (e) => this.onMessageLinkClick(e));

		// `@`-mention file autocomplete on the composer.
		this.fileSuggest = new FileSuggest(this.app, this.inputEl, this.inputRowEl);

		// On-screen keyboard: iOS/Obsidian present it natively with no standard web
		// signal (visualViewport/dvh/env all stay full-height). The native bridge does
		// fire keyboard events on `window` carrying the pixel height — use that to size
		// the view to the area above the keyboard so the composer pins just above it.
		const onShow = (e: Event): void => this.setKeyboardInset(Number((e as { keyboardHeight?: number }).keyboardHeight ?? 0));
		const onHide = (): void => this.setKeyboardInset(0);
		for (const ev of ["keyboardWillShow", "keyboardDidShow"]) {
			this.registerDomEvent(window as Window, ev as keyof WindowEventMap, onShow as EventListener);
		}
		for (const ev of ["keyboardWillHide", "keyboardDidHide"]) {
			this.registerDomEvent(window as Window, ev as keyof WindowEventMap, onHide as EventListener);
		}

		if (this.plugin.settings.debugKeyboardPanel) this.mountKbDebug();

		this.render();
	}

	async onClose(): Promise<void> {
		if (this.sessionsRefreshTimer !== undefined) window.clearTimeout(this.sessionsRefreshTimer);
		if (this.kbDebugTimer !== undefined) window.clearTimeout(this.kbDebugTimer);
		this.kbDebugEl?.remove();
		this.dlog?.log("view", "onClose (disconnect)");
		this.connDebugEl?.remove();
		this.resizeObserver?.disconnect();
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

		// Reload the current session from disk — same effect as re-picking it in the
		// session picker (drops the cached actor, replays fresh history, re-checks CLI activity).
		this.reloadBtn = toolbar.createEl("button", { cls: "occ-tool-btn" });
		setIcon(this.reloadBtn, "rotate-ccw");
		this.reloadBtn.setAttr("aria-label", "Reload current session");
		this.reloadBtn.addEventListener("click", () => {
			if (this.state.sessionId) this.resumeSession(this.state.sessionId, this.currentTitle);
		});

		const pickerBtn = toolbar.createEl("button", { cls: "occ-tool-btn" });
		setIcon(pickerBtn, "list");
		pickerBtn.setAttr("aria-label", "Resume a session");
		pickerBtn.addEventListener("click", () => this.togglePicker());

		const modelBtn = toolbar.createEl("button", { cls: "occ-model-btn" });
		this.modelLabelEl = modelBtn.createSpan({ cls: "occ-model-label" });
		setIcon(modelBtn.createSpan({ cls: "occ-model-caret" }), "chevron-down");
		modelBtn.setAttr("aria-label", "Choose the model for new sessions");
		modelBtn.addEventListener("click", (e) => this.openModelMenu(e));

		this.modeBtn = toolbar.createEl("button", { cls: "occ-tool-btn occ-mode-btn" });
		setIcon(this.modeBtn, "shield");
		this.modeBtn.setAttr("aria-label", "Permission mode");
		this.modeBtn.addEventListener("click", (e) => this.openModeMenu(e));

		// Kebab that mirrors the loaded session's picker actions (copy link, close, rename…).
		this.actionsBtn = toolbar.createEl("button", { cls: "occ-tool-btn" });
		setIcon(this.actionsBtn, "more-vertical");
		this.actionsBtn.setAttr("aria-label", "Current session actions");
		this.actionsBtn.addEventListener("click", (e) => this.openCurrentSessionActions(e));

		// Right-aligned status group: cost, connection, activity.
		const status = toolbar.createDiv({ cls: "occ-status" });
		this.costEl = status.createSpan({ cls: "occ-cost" });
		this.connIconEl = status.createSpan({ cls: "occ-status-icon" });
		this.connIconEl.addEventListener("click", () => this.openStatusLegend());
		this.activityIconEl = status.createSpan({ cls: "occ-status-icon" });
		this.activityIconEl.addEventListener("click", () => this.openStatusLegend());

		this.pickerEl = root.createDiv({ cls: "occ-picker occ-hidden" });
		this.todosEl = root.createEl("ul", { cls: "occ-todos" });

		const messagesWrap = root.createDiv({ cls: "occ-messages-wrap" });
		this.messagesEl = messagesWrap.createDiv({ cls: "occ-messages" });
		this.messagesInnerEl = this.messagesEl.createDiv({ cls: "occ-messages-inner" });
		this.scrollPillEl = messagesWrap.createDiv({ cls: "occ-scroll-pill occ-hidden" });
		setIcon(this.scrollPillEl, "chevron-down");
		this.scrollPillEl.createSpan({ text: "Latest" });
		this.scrollPillEl.addEventListener("click", () => this.scrollToBottom());
		this.registerDomEvent(this.messagesEl, "scroll", () => {
			const top = this.messagesEl.scrollTop;
			// Only a genuine upward scroll un-pins; content growing below must not.
			if (this.isNearBottom()) this.stickBottom = true;
			else if (top < this.lastScrollTop - 2) this.stickBottom = false;
			this.lastScrollTop = top;
			this.updateScrollPill();
		});
		// Re-pin to the bottom whenever content height changes (incl. async markdown).
		this.resizeObserver = new ResizeObserver(() => {
			if (this.stickBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			this.updateScrollPill();
		});
		this.resizeObserver.observe(this.messagesInnerEl);

		this.permissionEl = root.createDiv({ cls: "occ-permission-slot" });
		this.activityBannerEl = root.createDiv({ cls: "occ-activity-slot" });

		const inputRow = root.createDiv({ cls: "occ-input-row" });
		this.inputRowEl = inputRow;
		this.inputEl = inputRow.createEl("textarea");
		this.inputEl.placeholder = "Message Claude…";
		// Restore + persist the unsent draft across view reloads.
		this.inputEl.value = window.localStorage.getItem(this.draftKey()) ?? "";
		this.inputEl.addEventListener("input", () => window.localStorage.setItem(this.draftKey(), this.inputEl.value));
		this.inputEl.addEventListener("keydown", (e) => {
			// When the @-mention popover is open it owns ↑/↓/Enter/Tab (and Escape).
			if (this.fileSuggest?.handleKeydown(e)) return;
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendCurrent();
			}
		});
		this.sendBtn = inputRow.createEl("button", { text: "Send", cls: "mod-cta" });
		this.sendBtn.addEventListener("click", () => {
			if (this.state.status === "working") {
				if (this.state.sessionId) this.client.interrupt(this.state.sessionId);
			} else {
				this.sendCurrent();
			}
		});
	}

	/**
	 * Size the view to the space above the on-screen keyboard so the composer pins
	 * just above it. `keyboardHeight` (px) comes from the native bridge event; 0
	 * clears the override (keyboard hidden → back to the CSS full-height).
	 */
	/** True when this view's leaf lives in the main editor area (not a left/right sidebar). */
	private isInMainArea(): boolean {
		try {
			return this.leaf.getRoot() === this.app.workspace.rootSplit;
		} catch {
			return false;
		}
	}

	/**
	 * Toggle `occ-phone-main`, which drives the bottom navbar inset in styles.css. On
	 * iPhone, Obsidian's mobile navbar overlaps only the main-area leaf; a sidebar leaf
	 * has its own bottom toolbar and must NOT get the inset.
	 */
	private updateLeafLocationClass(): void {
		this.contentEl.toggleClass("occ-phone-main", Platform.isPhone && this.isInMainArea());
	}

	private setKeyboardInset(keyboardHeight: number): void {
		// iPad needs a different strategy than iPhone (see setKeyboardInsetTablet).
		if (Platform.isTablet) {
			this.setKeyboardInsetTablet(keyboardHeight);
			return;
		}
		const cc = this.contentEl;
		if (keyboardHeight > 0) {
			const top = cc.getBoundingClientRect().top;
			const avail = Math.max(160, window.innerHeight - keyboardHeight - top);
			// Pin the height hard. `height` alone is not honoured here: contentEl is a
			// flex item, and on the iPad OSK it springs back to its content's min size
			// (~510px measured), leaving the composer behind the keyboard. Setting
			// min/max-height to the same value (and flex:none) defeats both the
			// min-content floor and any flex-grow stretch so the box is exactly `avail`.
			cc.style.height = `${avail}px`;
			cc.style.minHeight = `${avail}px`;
			cc.style.maxHeight = `${avail}px`;
			cc.style.flex = "none";
			// `flex:1` doesn't distribute space while the keyboard is up in this webview,
			// so the composer won't pin to the bottom on its own. Lay the view out
			// explicitly: composer absolute at the bottom, messages a definite scroll
			// band between the toolbar and the composer (see the .occ-kb-open CSS).
			const toolbar = cc.querySelector(".occ-toolbar") as HTMLElement | null;
			cc.style.setProperty("--occ-msg-top", `${(toolbar?.offsetHeight ?? 48) + 8}px`);
			// Composer sits `bottom: 8px` above the keyboard; leave another ~10px between
			// it and the messages band so neither edge feels cramped.
			cc.style.setProperty("--occ-msg-bottom", `${this.inputRowEl.offsetHeight + 18}px`);
			cc.addClass("occ-kb-open");
		} else {
			cc.style.height = "";
			cc.style.minHeight = "";
			cc.style.maxHeight = "";
			cc.style.flex = "";
			cc.removeClass("occ-kb-open");
			cc.style.removeProperty("--occ-msg-top");
			cc.style.removeProperty("--occ-msg-bottom");
		}
		if (this.stickBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/**
	 * iPad keyboard layout. The iPhone strategy (pin contentEl's height, compose with
	 * `bottom`-anchored absolutes) doesn't work here: iPad WebKit refuses to shrink
	 * contentEl below its ~510px content floor, so its bottom edge sits behind the
	 * keyboard and anything anchored to it (or to `flex:1`) lands wrong — the composer
	 * either hides behind the keyboard or floats up under the toolbar.
	 *
	 * What IS stable on iPad: contentEl's TOP (134px, measured) and the real keyboard
	 * top (`innerHeight - keyboardHeight`; visualViewport is inert so we compute it).
	 * So anchor everything by `top` instead of `bottom`: place the composer's top so its
	 * bottom lands just above the keyboard, and give the messages a definite band above
	 * it. `overflow:hidden` clips the dead contentEl area that hangs behind the keyboard.
	 */
	private setKeyboardInsetTablet(keyboardHeight: number): void {
		const cc = this.contentEl;
		if (keyboardHeight > 0) {
			const ccTop = cc.getBoundingClientRect().top;
			const kbTop = window.innerHeight - keyboardHeight; // real keyboard top (px)
			const toolbar = cc.querySelector(".occ-toolbar") as HTMLElement | null;
			const toolbarH = toolbar?.offsetHeight ?? 48;
			const compH = this.inputRowEl.offsetHeight;
			const bandTop = toolbarH + 8;
			// Composer top, in contentEl-relative px, so its bottom sits `gap` above the
			// kb. 16px (not 8) keeps the input's rounded corner clear of the keyboard edge.
			const gap = 16;
			const composerTop = Math.max(bandTop, kbTop - ccTop - compH - gap);
			const bandHeight = Math.max(80, composerTop - bandTop - 10);
			cc.style.setProperty("--occ-msg-top", `${bandTop}px`);
			cc.style.setProperty("--occ-band-height", `${bandHeight}px`);
			cc.style.setProperty("--occ-composer-top", `${composerTop}px`);
			cc.addClass("occ-kb-tablet");
		} else {
			cc.removeClass("occ-kb-tablet");
			cc.style.removeProperty("--occ-msg-top");
			cc.style.removeProperty("--occ-band-height");
			cc.style.removeProperty("--occ-composer-top");
		}
		if (this.stickBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	// --- on-screen-keyboard debug panel (gated behind the debugKeyboardPanel setting) ---
	// Diagnoses mobile keyboard/layout issues on devices the maintainer can't reach. A
	// small "Copy KB" button (top-right, clear of the status bar and above the keyboard)
	// copies a text layout report to the clipboard, which an issue reporter pastes back.
	// A rolling history of geometry snapshots (every 500ms + on each keyboard event) keeps
	// the keyboard-UP frames. Field reference + platform model: docs/MOBILE_KEYBOARD_DEBUG.md.
	// Inline styles are intentional here (throwaway debug DOM, not part of the styled UI).
	private mountKbDebug(): void {
		// Record raw keyboard events (name + reported height) so we can see whether the
		// iPad OSK fires them at all and what height it carries.
		const rec = (name: string) => (e: Event): void => {
			const h = (e as { keyboardHeight?: number }).keyboardHeight;
			if (typeof h === "number") this.kbLastHeight = name.includes("Hide") ? 0 : h;
			this.kbLog.push(`${name}(${h ?? "?"})@${this.kbElapsed()}`);
			this.kbLog = this.kbLog.slice(-12);
			this.kbSnapshot(`<<${name}>>`);
		};
		for (const ev of ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"]) {
			this.registerDomEvent(window as Window, ev as keyof WindowEventMap, rec(ev) as EventListener);
		}

		const btn = document.body.createEl("button", { text: "Copy KB" });
		this.kbDebugEl = btn;
		btn.style.position = "fixed";
		// Top-right, offset down: clears the iPad status bar/clock (which hid the
		// original top overlay) AND stays above the keyboard, so it's tappable while
		// the keyboard is up.
		btn.style.top = "56px";
		btn.style.right = "6px";
		btn.style.zIndex = "99999";
		btn.style.font = "11px monospace";
		btn.style.padding = "6px 10px";
		btn.style.background = "#1a4";
		btn.style.color = "#fff";
		btn.style.border = "1px solid #fff";
		btn.style.borderRadius = "6px";
		btn.style.opacity = "0.85";
		btn.addEventListener("click", () => this.copyToClipboard(this.kbReport(), "KB measurements copied"));

		// ~30 snapshots @500ms ≈ 15s of history — plenty for raise→hold→dismiss→copy.
		const tick = (): void => {
			if (!this.kbDebugEl) return;
			this.kbSnapshot();
			btn.setText(`Copy KB (${this.kbHistory.length})`);
			this.kbDebugTimer = window.setTimeout(tick, 500);
		};
		tick();
	}

	private kbElapsed(): string {
		if (this.kbStartMs === 0) this.kbStartMs = Date.now();
		return `+${((Date.now() - this.kbStartMs) / 1000).toFixed(1)}s`;
	}

	/** Append one geometry snapshot line to the rolling history (cap 30). */
	private kbSnapshot(tag = ""): void {
		const cc = this.contentEl;
		const r = cc.getBoundingClientRect();
		const comp = this.inputRowEl?.getBoundingClientRect();
		const cs = cc.style;
		const gcs = window.getComputedStyle(cc);
		const parent = cc.parentElement;
		const pr = parent?.getBoundingClientRect();
		const leafBot = pr ? Math.round(pr.bottom) : undefined;
		const n = (v: number | undefined): string => (v === undefined ? "—" : Math.round(v).toString());
		// Real keyboard top = layout-viewport height − reported keyboard height
		// (visualViewport is inert on iOS, so it can't tell us this).
		const visBottom = window.innerHeight - this.kbLastHeight;
		const behind = comp && comp.bottom > visBottom + 1 ? "BEHIND-KB" : "visible";
		const focused = document.activeElement === this.inputEl ? "F" : "-";
		// Which keyboard layout is active (iPhone uses occ-kb-open, iPad occ-kb-tablet).
		const layout = cc.hasClass("occ-kb-open") ? "open" : cc.hasClass("occ-kb-tablet") ? "tablet" : "none";
		const line =
			`[${this.kbElapsed()}]${tag ? " " + tag : ""} foc=${focused} kbH=${this.kbLastHeight} ` +
			`cc top=${n(r.top)} bot=${n(r.bottom)} h=${n(r.height)} styleH=${cs.height || "—"} usedH=${gcs.height} minH=${gcs.minHeight} maxH=${gcs.maxHeight} kbLayout=${layout} | ` +
			`parent=${parent?.className || "?"} ph=${n(pr?.height)} leafBot=${leafBot ?? "—"} | ` +
			`comp top=${n(comp?.top)} bot=${n(comp?.bottom)} visBot=${n(visBottom)} => ${behind}`;
		this.kbHistory.push(line);
		this.kbHistory = this.kbHistory.slice(-30);
	}

	/** Build the full clipboard report: static device facts + event log + history. */
	private kbReport(): string {
		const vv = window.visualViewport;
		// Read env(safe-area-inset-*) via a probe (can't be read off the document directly).
		const probe = document.body.createDiv();
		probe.style.position = "fixed";
		probe.style.bottom = "0";
		probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
		probe.style.paddingTop = "env(safe-area-inset-top, 0px)";
		const safeBottom = window.getComputedStyle(probe).paddingBottom;
		const safeTop = window.getComputedStyle(probe).paddingTop;
		probe.remove();
		return [
			`=== OSK debug (${this.kbElapsed()}) ===`,
			`win inner ${window.innerWidth}x${window.innerHeight} outer ${window.outerWidth}x${window.outerHeight}`,
			`screen ${screen.width}x${screen.height} avail ${screen.availWidth}x${screen.availHeight}`,
			`docEl.client h=${document.documentElement.clientHeight} vv.scale=${vv?.scale ?? "—"}`,
			`safe-area top=${safeTop} bottom=${safeBottom} | body.clientH=${document.body.clientHeight}`,
			`KB events: ${this.kbLog.join("  ") || "(NONE fired)"}`,
			"",
			"snapshots (oldest→newest):",
			...this.kbHistory,
		].join("\n");
	}

	/**
	 * Connection-debug panel: a small fixed widget (top-right, like the KB panel) that
	 * shows only the captured-line count and three buttons — Copy (full report to the
	 * clipboard), Mark (numbered section marker), Clear (reset). The log itself is not
	 * shown, to stay out of the way. Gated behind the debugConnectionPanel setting.
	 */
	private mountConnDebug(): void {
		const panel = document.body.createDiv();
		this.connDebugEl = panel;
		Object.assign(panel.style, {
			position: "fixed",
			// Below the KB panel's slot (top:56px) so both can coexist without overlap.
			top: "96px",
			right: "6px",
			zIndex: "99999",
			display: "flex",
			gap: "4px",
			font: "11px monospace",
			opacity: "0.85",
		} as Partial<CSSStyleDeclaration>);

		const mkBtn = (label: string): HTMLButtonElement => {
			const b = panel.createEl("button", { text: label });
			Object.assign(b.style, {
				font: "11px monospace",
				padding: "6px 8px",
				background: "#1a4",
				color: "#fff",
				border: "1px solid #fff",
				borderRadius: "6px",
			} as Partial<CSSStyleDeclaration>);
			return b;
		};

		const copy = mkBtn("Copy");
		this.connDebugCopyBtn = copy;
		copy.addEventListener("click", () => this.copyToClipboard(this.dlog?.report() ?? "", "Connection log copied"));
		const mark = mkBtn("Mark");
		mark.addEventListener("click", () => {
			const n = this.dlog?.marker();
			if (n !== undefined) new Notice(`Marker ${n} added`, 1500);
		});
		const clear = mkBtn("Clr");
		clear.addEventListener("click", () => this.dlog?.clear());

		this.renderConnDebug();
	}

	/** Refresh the captured-line count on the Copy button (via the DebugLog onChange hook). */
	private renderConnDebug(): void {
		if (!this.connDebugCopyBtn || !this.dlog) return;
		this.connDebugCopyBtn.setText(`Copy (${this.dlog.count()})`);
	}

	/**
	 * Reconcile the connection-debug panel with the current setting, so toggling it
	 * applies to already-open views without an app restart. Called by the plugin when
	 * the setting changes.
	 */
	syncConnDebugPanel(): void {
		const enabled = this.plugin.settings.debugConnectionPanel;
		if (enabled && !this.dlog) {
			this.dlog = new DebugLog({ store: window.localStorage, onChange: () => this.renderConnDebug() });
			this.dlog.log("view", "panel enabled");
			this.mountConnDebug();
		} else if (!enabled && this.dlog) {
			this.connDebugEl?.remove();
			this.connDebugEl = undefined;
			this.connDebugCopyBtn = undefined;
			this.dlog = undefined;
			DebugLog.purge(window.localStorage);
		}
	}

	private startNewSession(): void {
		this.pickerOpen = false;
		this.stickBottom = true;
		this.applyDesiredMode = true;
		this.currentTitle = undefined;
		this.updateTabTitle();
		this.dlog?.log("view", "startNewSession");
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

	/**
	 * Open a specific session in this view (e.g. from an `obsidian://occ-chat` link).
	 * Connection-aware: resumes immediately if the socket is up, else defers until the
	 * `ready` frame arrives (a freshly-revealed view is still connecting).
	 */
	openSession(sessionId: string, messageId?: string): void {
		this.pendingOpenSession = undefined;
		// Target a specific message: resolved after the transcript loads by paging older
		// until it appears (see tryResolveDeepLink). Cleared once found or exhausted.
		this.pendingScrollTo = messageId;
		this.deepLinkLoading = false;
		if (this.client?.isConnected()) {
			this.resumeSession(sessionId);
		} else {
			this.pendingOpenSession = sessionId;
			this.client?.connect(); // idempotent if already connecting; onEvent(ready) flushes it
		}
	}

	/**
	 * Open a session — ALWAYS reloads from disk (drops any cached actor) so the plugin
	 * shows current content; the re-attach re-checks CLI activity. Used by the picker
	 * and the read-only banner's Reload button.
	 */
	private resumeSession(sessionId: string, title?: string): void {
		this.dlog?.log("view", `resumeSession ${sessionId} (reload)`);
		this.pickerOpen = false;
		this.pendingText = undefined;
		this.stickBottom = true; // switching in should always land at the bottom
		this.currentTitle = title ?? this.currentTitle;
		this.updateTabTitle();
		// Clear the current transcript; the resumed session's history replays in.
		this.state = { ...initialState(this.selectedModel), connection: this.state.connection };
		this.client.resumeSession(sessionId, /* reload */ true);
		this.render();
	}

	private sendCurrent(): void {
		const text = this.inputEl.value.trim();
		if (!text) return;
		// Read-only while a CLI holds the session (Send is disabled too — belt and braces).
		if (this.state.sessionId && this.state.externalActivity !== "none") return;
		this.dispatchSend(text);
	}

	private dispatchSend(text: string): void {
		this.inputEl.value = "";
		window.localStorage.removeItem(this.draftKey());
		this.stickBottom = true; // following our own new message
		if (this.state.sessionId) {
			this.lastSentText = text;
			this.client.userMessage(this.state.sessionId, text);
			this.state = appendUserMessage(this.state, text);
		} else {
			// No session yet — open one and flush the text when it's ready. Do NOT append
			// the user bubble optimistically here: the new session's attach emits an
			// `attach_reset` that would wipe it (leaving the first prompt invisible until a
			// reload). Append it when we flush pendingText, after the reset — see onEvent →
			// session_status.
			this.pendingText = text;
			this.applyDesiredMode = true;
			this.client.newSession(this.selectedModel);
		}
		this.render();
	}

	/** Server refused a send (a CLI grabbed the session in the gap): roll back + restore. */
	private restoreBlockedDraft(): void {
		if (this.lastSentText !== undefined) {
			const items = this.state.items;
			const last = items[items.length - 1];
			if (last && last.kind === "user" && last.text === this.lastSentText) {
				this.state = { ...this.state, items: items.slice(0, -1) };
			}
			this.inputEl.value = this.lastSentText;
			window.localStorage.setItem(this.draftKey(), this.lastSentText);
			this.lastSentText = undefined;
		}
		new Notice("Not sent — this session is open in a terminal (read-only).", 5000);
		this.render();
	}

	/** Per-leaf draft key so parallel chat tabs don't clobber each other's draft. */
	private draftKey(): string {
		const id = (this.leaf as unknown as { id?: string }).id;
		return id ? `${DRAFT_KEY}:${id}` : DRAFT_KEY;
	}

	private onEvent(event: BridgeEvent): void {
		this.state = applyEvent(this.state, event);
		if (event.type === "send_blocked") {
			this.restoreBlockedDraft();
			return; // restoreBlockedDraft re-renders
		}
		// A deep-link (openSession) opened this view while still connecting: now that the
		// socket is ready, resume the requested session.
		if (event.type === "ready" && this.pendingOpenSession) {
			const sessionId = this.pendingOpenSession;
			this.pendingOpenSession = undefined;
			this.resumeSession(sessionId);
		}
		if (event.type === "history_page") {
			// Capture pre-prepend metrics so render() can keep the viewport stable.
			this.prependAdjust = { prevHeight: this.messagesEl.scrollHeight, prevTop: this.messagesEl.scrollTop };
			this.deepLinkLoading = false; // this page arrived; the resolver may request the next
		}
		if (event.type === "sessions_list") {
			this.sessionsLoading = false;
			this.sessionsLastOk = Date.now();
			if (this.sessionsRefreshTimer !== undefined) {
				window.clearTimeout(this.sessionsRefreshTimer);
				this.sessionsRefreshTimer = undefined;
			}
			// Keep the tab title in sync if the current session's title changed.
			const cur = event.sessions.find((s) => s.sessionId === this.state.sessionId);
			if (cur?.title) {
				this.currentTitle = cur.title;
				this.updateTabTitle();
			}
		}
		if (event.type === "session_status" && event.sessionId) {
			if (this.pendingText) {
				const pending = this.pendingText;
				this.pendingText = undefined;
				this.client.userMessage(event.sessionId, pending);
				// Append the user bubble now — AFTER this attach's `attach_reset` — so it
				// isn't wiped. The server buffers it as a non-broadcast `user_echo`, so this
				// optimistic copy is the only live one (mirrors the existing-session send).
				this.state = appendUserMessage(this.state, pending);
			}
			// Carry the chosen permission mode into a freshly-started session.
			if (this.applyDesiredMode) {
				this.applyDesiredMode = false;
				if (this.desiredMode !== "default" && this.desiredMode !== event.permissionMode) {
					this.client.setPermissionMode(event.sessionId, this.desiredMode);
				}
			}
		}
		if (event.type === "error") new Notice(`Claude: ${event.message}`, 5000);
		// Alert when a turn finishes while the app isn't visible.
		if (event.type === "done" && document.hidden) new Notice("Claude finished responding", 5000);
		this.render();
		// Resolve a pending deep-link at stable points (after replay / each older page),
		// where hasOlderHistory is accurate and the DOM reflects the latest transcript.
		if (event.type === "session_status" || event.type === "history_page") this.tryResolveDeepLink();
	}

	/**
	 * Scroll a deep link's target message into view, paging older until it's loaded.
	 * The newest page loads first, so paging older brings in everything younger than the
	 * target too. Gives up (with a notice) once history is exhausted without a match.
	 */
	private tryResolveDeepLink(): void {
		const id = this.pendingScrollTo;
		if (!id) return;
		const el = this.messagesInnerEl.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) as HTMLElement | null;
		if (el) {
			this.pendingScrollTo = undefined;
			this.deepLinkLoading = false;
			this.scrollToAndHighlight(el);
			return;
		}
		if (this.state.hasOlderHistory && this.state.sessionId) {
			if (this.deepLinkLoading) return; // a page is in flight; wait for history_page
			this.deepLinkLoading = true;
			this.client.loadOlder(this.state.sessionId);
			return;
		}
		// History exhausted and still not found (e.g. a thinking bubble, absent from history).
		this.pendingScrollTo = undefined;
		this.deepLinkLoading = false;
		new Notice("Linked message not found in this conversation.", 3000);
	}

	private scrollToAndHighlight(el: HTMLElement): void {
		this.stickBottom = false; // don't let the bottom-pin fight the scroll-to-target
		const go = (): void => el.scrollIntoView({ block: "center" });
		go();
		// Assistant markdown renders async and shifts layout; re-pin a couple of times.
		window.setTimeout(go, 120);
		window.setTimeout(go, 400);
		el.addClass("occ-msg-highlight");
		window.setTimeout(() => el.removeClass("occ-msg-highlight"), 2200);
	}

	private decide(toolUseId: string, allow: boolean): void {
		if (!this.state.sessionId) return;
		this.client.decide(this.state.sessionId, toolUseId, allow);
		this.state = clearPermission(this.state, toolUseId);
		this.render();
	}

	// -- rendering -----------------------------------------------------------

	private render(): void {
		this.updateTabTitle(); // keep the header/tab in sync with the loaded session (cheap; no-ops if unchanged)
		this.renderStatus();
		this.renderPicker();
		this.renderTodos();
		// `stickBottom` is the persistent intent: only user scrolling turns it off.
		// The full re-render resets scrollTop, so we re-apply it here.
		const prevTop = this.messagesEl.scrollTop;
		this.renderMessages();
		this.renderPermission();
		this.renderActivityBanner();
		if (this.prependAdjust) {
			// Keep the previously-visible messages in place after prepending older ones.
			this.messagesEl.scrollTop = this.prependAdjust.prevTop + (this.messagesEl.scrollHeight - this.prependAdjust.prevHeight);
			this.prependAdjust = undefined;
			this.stickBottom = false;
		} else if (this.stickBottom) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			this.pinToBottomSoon();
		} else {
			this.messagesEl.scrollTop = prevTop;
		}
		this.updateScrollPill();
	}

	/** Re-pin to the bottom across the next few frames to catch late async layout. */
	private pinToBottomSoon(): void {
		const pin = (): void => {
			if (this.stickBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		};
		requestAnimationFrame(pin);
		window.setTimeout(pin, 60);
		window.setTimeout(pin, 250);
	}

	private isNearBottom(): boolean {
		const el = this.messagesEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		this.updateScrollPill();
	}

	private updateScrollPill(): void {
		this.scrollPillEl.toggleClass("occ-hidden", this.isNearBottom());
	}

	private renderPicker(): void {
		this.pickerEl.toggleClass("occ-hidden", !this.pickerOpen);
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
			main.addEventListener("click", () => this.resumeSession(s.sessionId, named || undefined));

			const label = named || `New session — started ${startedAgo}`;
			const more = item.createEl("button", { cls: "occ-picker-more" });
			setIcon(more, "more-vertical");
			more.setAttr("aria-label", "Session actions");
			more.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openSessionActions(e, s.sessionId, named || "", label);
			});
		}
	}

	/** Toolbar kebab: open the loaded session's action menu (mirrors its picker kebab). */
	private openCurrentSessionActions(evt: MouseEvent): void {
		if (!this.state.sessionId) return;
		this.openSessionActions(evt, this.state.sessionId, this.currentTitle ?? "", this.currentSessionName());
	}

	private openSessionActions(evt: MouseEvent, sessionId: string, currentTitle: string, label: string): void {
		const menu = new Menu();
		// Copy a note-ready link WITHOUT touching the session (no close/switch).
		menu.addItem((i) =>
			i
				.setTitle("Copy Obsidian link")
				.setIcon("link")
				.onClick(() => this.copyToClipboard(conversationLinkFromParts(sessionId, currentTitle), "Conversation link copied"))
		);
		menu.addItem((i) =>
			i
				.setTitle("Copy resume command & close session")
				.setIcon("terminal")
				.onClick(() => {
					this.copyToClipboard(`claude --resume ${sessionId}`, "Resume command copied — session closed for the terminal");
					this.closeSession(sessionId); // hand off to the terminal: release it
				})
		);
		menu.addItem((i) =>
			i
				.setTitle("Close session")
				.setIcon("log-out")
				.onClick(() => this.closeSession(sessionId))
		);
		menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => this.openRename(sessionId, currentTitle)));
		menu.addItem((i) => i.setTitle("Delete…").setIcon("trash-2").onClick(() => this.confirmDelete(sessionId, label)));
		menu.showAtMouseEvent(evt);
	}

	/**
	 * Release a session server-side (frees the writer lock; does NOT delete the
	 * store). If it's the session we're viewing, also detach back to the empty
	 * state; otherwise just refresh the picker so its status reflects the release.
	 */
	private closeSession(sessionId: string): void {
		this.client.closeSession(sessionId);
		if (sessionId === this.state.sessionId) {
			this.pickerOpen = false;
			this.client.setAttachTarget(undefined); // don't re-attach on reconnect
			this.pendingText = undefined;
			this.currentTitle = undefined;
			this.updateTabTitle();
			this.state = { ...initialState(this.selectedModel), connection: this.state.connection };
		}
		this.refreshSessions();
		this.render();
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
			if (sessionId === this.state.sessionId) {
				this.currentTitle = title;
				this.updateTabTitle();
			}
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

		const working = this.state.status === "working";
		const readOnly = !!this.state.sessionId && this.state.externalActivity !== "none";
		let icon = "check";
		let cls = "idle";
		let label = "Idle — ready";
		if (this.state.status === "awaiting_permission") {
			[icon, cls, label] = ["alert-triangle", "awaiting", "Awaiting your permission"];
		} else if (working) {
			[icon, cls, label] = ["loader", "working", "Working…"];
		} else if (readOnly) {
			[icon, cls, label] = ["lock", "readonly", "Read-only — open in a terminal"];
		}
		setIcon(this.activityIconEl, icon);
		this.activityIconEl.className = `occ-status-icon occ-act-${cls}`;
		this.activityIconEl.setAttr("aria-label", label);

		// Nothing to reload / act on until a session is attached.
		this.reloadBtn.disabled = !this.state.sessionId;
		this.actionsBtn.disabled = !this.state.sessionId;

		// The Send button doubles as Stop while a turn is running; locked when read-only.
		this.sendBtn.setText(working ? "Stop" : "Send");
		this.sendBtn.disabled = readOnly && !working;
		this.sendBtn.classList.toggle("mod-warning", working);
		this.sendBtn.classList.toggle("mod-cta", !working && !this.sendBtn.disabled);
		this.inputEl.disabled = readOnly;
		this.inputEl.placeholder = readOnly ? "Read-only — open in a terminal" : "Message Claude…";

		this.costEl.setText(typeof this.state.costUsd === "number" ? `$${this.state.costUsd.toFixed(2)}` : "");

		this.modelLabelEl.setText(MODEL_OPTIONS[this.selectedModel] ?? this.selectedModel);

		const mode = (this.state.sessionId ? this.state.permissionMode : this.desiredMode) ?? "default";
		const modeMeta = PERMISSION_MODES.find((m) => m.mode === mode) ?? PERMISSION_MODES[0]!;
		setIcon(this.modeBtn, modeMeta.icon);
		this.modeBtn.setAttr("aria-label", `Permission: ${modeMeta.label}`);
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

	private openModeMenu(evt: MouseEvent): void {
		const current = (this.state.sessionId ? this.state.permissionMode : this.desiredMode) ?? "default";
		const menu = new Menu();
		for (const m of PERMISSION_MODES) {
			menu.addItem((item) =>
				item
					.setTitle(m.label)
					.setChecked(m.mode === current)
					.onClick(() => {
						this.desiredMode = m.mode;
						if (this.state.sessionId) this.client.setPermissionMode(this.state.sessionId, m.mode);
						this.render();
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private openStatusLegend(): void {
		new StatusLegendModal(this.app, this.state.connection, () => this.client?.checkAlive()).open();
	}

	private renderTodos(): void {
		this.todosEl.empty();
		for (const todo of this.state.todos) {
			const mark = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○";
			this.todosEl.createEl("li", { text: `${mark} ${todo.content}` });
		}
	}

	private renderMessages(): void {
		this.messagesInnerEl.empty();
		if (this.state.hasOlderHistory) {
			const older = this.messagesInnerEl.createEl("button", { cls: "occ-load-older", text: "↑ Load older messages" });
			older.addEventListener("click", () => {
				if (this.state.sessionId) this.client.loadOlder(this.state.sessionId);
			});
		}
		for (const item of this.state.items) {
			if (item.kind === "user") {
				const bubble = this.messagesInnerEl.createDiv({ cls: "occ-bubble occ-user" });
				if (item.id) bubble.setAttr("data-msg-id", item.id);
				bubble.createDiv({ text: item.text });
				this.addMsgActions(bubble, item.text, item.id);
			} else if (item.kind === "assistant") {
				const bubble = this.messagesInnerEl.createDiv({ cls: "occ-bubble occ-assistant" });
				if (item.id) bubble.setAttr("data-msg-id", item.id);
				this.addMsgActions(bubble, item.text, item.id);
				const content = bubble.createDiv({ cls: "occ-bubble-content" });
				// Obsidian's MarkdownRenderer adds its own code-block copy button and
				// renders asynchronously; the ResizeObserver re-pins us to the bottom.
				void MarkdownRenderer.render(this.app, item.text, content, "", this);
			} else if (item.kind === "thinking") {
				const bubble = this.messagesInnerEl.createDiv({ cls: "occ-thinking" });
				if (item.id) bubble.setAttr("data-msg-id", item.id);
				bubble.createDiv({ cls: "occ-thinking-text", text: item.text });
				this.addMsgActions(bubble, item.text, item.id);
			} else {
				this.renderTool(item.entry);
			}
		}
		if (this.state.items.length === 0) {
			this.messagesInnerEl.createDiv({
				cls: "occ-empty",
				text: "Start chatting — type a message below, or tap the list icon to resume a past session.",
			});
		}
	}

	/**
	 * Delegated handler for clicks on links inside rendered assistant messages.
	 * Opens links that resolve to a vault file in Obsidian (Ctrl/Cmd → new pane);
	 * genuine external URLs fall through to their default behaviour.
	 */
	private onMessageLinkClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const anchor = target?.closest?.("a");
		if (!anchor) return;
		// Wikilinks render as `a.internal-link` carrying the linkpath in data-href;
		// markdown links keep it in href. Prefer data-href, fall back to href.
		const raw = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
		if (!raw) return;
		// Leave schemed URLs (https:, mailto:, obsidian:, …) to open normally.
		if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
		const linktext = raw.replace(/^\.\//, "");
		// Strip any heading (#) / block (^) ref before resolving the file path.
		const path = linktext.split(/[#^]/)[0] ?? linktext;
		if (!path) return;
		const dest = this.app.metadataCache.getFirstLinkpathDest(path, "");
		if (!dest) return; // not a vault file — let the default behaviour stand
		evt.preventDefault();
		void this.app.workspace.openLinkText(linktext, "", evt.ctrlKey || evt.metaKey);
	}

	/** Copy `text` to the clipboard with a brief confirmation. */
	private copyToClipboard(text: string, okMessage = "Copied"): void {
		const clip = navigator.clipboard;
		if (!clip) {
			new Notice("Clipboard unavailable", 2000);
			return;
		}
		void clip.writeText(text).then(
			() => new Notice(okMessage, 2000),
			() => new Notice("Copy failed", 2000)
		);
	}

	/**
	 * Per-message kebab: copy the message text, and copy an Obsidian deep link to this
	 * exact message. `msgId` is the stable anchor (SDK message uuid / tool-use id); when
	 * absent (a live-only bubble not yet in history, e.g. a just-sent user turn) the link
	 * action falls back to a conversation-level link.
	 */
	private addMsgActions(bubble: HTMLElement, text: string, msgId?: string): void {
		const btn = bubble.createEl("button", { cls: "occ-msg-actions" });
		setIcon(btn, "more-vertical");
		btn.setAttr("aria-label", "Message actions");
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Copy").setIcon("copy").onClick(() => this.copyToClipboard(text)));
			menu.addItem((i) =>
				i
					.setTitle("Copy link to this message")
					.setIcon("link")
					.onClick(() => this.copyMessageLink(msgId))
			);
			menu.showAtMouseEvent(e);
		});
	}

	/** Copy a deep link to a specific message (or the conversation, if not yet anchorable). */
	private copyMessageLink(msgId?: string): void {
		const sessionId = this.state.sessionId;
		if (!sessionId) return;
		if (!msgId) {
			this.copyToClipboard(
				conversationLinkFromParts(sessionId, this.currentSessionName()),
				"Linked to the conversation (this message isn't anchorable yet — reload the session to link it exactly)"
			);
			return;
		}
		this.copyToClipboard(conversationLinkFromParts(sessionId, this.currentSessionName(), msgId), "Message link copied");
	}


	private renderTool(entry: ToolEntry): void {
		const expanded = this.expandedTools.has(entry.toolUseId);
		const cls = entry.result?.isError ? "occ-tool occ-tool-error" : "occ-tool";
		const el = this.messagesInnerEl.createDiv({ cls });
		el.setAttr("data-msg-id", entry.toolUseId); // stable anchor for deep-linking
		// Kebab: copy the tool's result/input, or a deep link to this tool call.
		const copyText = entry.result?.content ?? (typeof entry.input === "object" && entry.input ? JSON.stringify(entry.input, null, 2) : "");
		this.addMsgActions(el, copyText, entry.toolUseId);

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
		body.toggleClass("occ-hidden", !expanded);
		if (inputStr) body.createEl("pre", { cls: "occ-tool-input", text: inputStr });
		if (entry.result) {
			const c = entry.result.content;
			body.createEl("pre", { text: c.length > 8000 ? c.slice(0, 8000) + "\n…(truncated)" : c });
		}

		header.addEventListener("click", () => {
			const open = !this.expandedTools.has(entry.toolUseId);
			if (open) this.expandedTools.add(entry.toolUseId);
			else this.expandedTools.delete(entry.toolUseId);
			body.toggleClass("occ-hidden", !open);
			setIcon(chevron, open ? "chevron-down" : "chevron-right");
		});
	}

	private renderPermission(): void {
		this.permissionEl.empty();
		const req = this.state.pendingPermission;
		if (!req) return;
		const box = this.permissionEl.createDiv({ cls: "occ-permission" });
		const head = box.createDiv({ cls: "occ-permission-head" });
		setIcon(head.createSpan({ cls: "occ-permission-icon" }), "alert-triangle");
		head.createSpan({ text: `Allow ${req.name}?` });
		box.createEl("pre", { cls: "occ-permission-input", text: permissionInputText(req.input) });
		const buttons = box.createDiv({ cls: "occ-permission-buttons" });
		const deny = buttons.createEl("button", { text: "Deny", cls: "mod-cta" });
		deny.addEventListener("click", () => this.decide(req.toolUseId, false));
		const allow = buttons.createEl("button", { text: "Allow", cls: "mod-warning" });
		allow.addEventListener("click", () => this.decide(req.toolUseId, true));
	}

	/** Read-only banner: the session is open in a live external (CLI) process. */
	private renderActivityBanner(): void {
		this.activityBannerEl.empty();
		if (!this.state.sessionId || this.state.externalActivity === "none") return;
		const box = this.activityBannerEl.createDiv({ cls: "occ-activity occ-activity-readonly" });
		const head = box.createDiv({ cls: "occ-activity-head" });
		setIcon(head.createSpan({ cls: "occ-activity-icon" }), "lock");
		const who = this.state.externalEntrypoint ? ` (${this.state.externalEntrypoint})` : "";
		head.createSpan({ text: `Open in a terminal${who} — read-only. Reload to refresh / regain control.` });
		const buttons = box.createDiv({ cls: "occ-activity-buttons" });
		const reload = buttons.createEl("button", { text: "Reload", cls: "mod-cta" });
		reload.addEventListener("click", () => {
			if (this.state.sessionId) this.resumeSession(this.state.sessionId, this.currentTitle);
		});
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
		const input = contentEl.createEl("input", { cls: "occ-modal-input" });
		input.type = "text";
		input.value = this.current;
		input.placeholder = "Session title";

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
	{ icon: "lock", cls: "occ-act-readonly", desc: "Read-only — the session is open in a terminal (CLI)" },
];

class StatusLegendModal extends Modal {
	constructor(
		app: App,
		private readonly connection: ConnectionState,
		private readonly onReconnect: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Status & connection" });

		const row = contentEl.createDiv({ cls: "occ-legend-conn" });
		row.createSpan({ text: `Connection: ${this.connection}` });
		const btn = row.createEl("button", { text: "Test / reconnect now", cls: "mod-cta" });
		btn.addEventListener("click", () => {
			this.onReconnect();
			new Notice("Checking connection…", 2000);
			this.close();
		});

		contentEl.createEl("h4", { text: "Status icons" });
		for (const entry of STATUS_LEGEND) {
			if ("heading" in entry) {
				contentEl.createEl("h5", { text: entry.heading });
				continue;
			}
			const legendRow = contentEl.createDiv({ cls: "occ-legend-row" });
			const ic = legendRow.createSpan({ cls: `occ-status-icon ${entry.cls}` });
			setIcon(ic, entry.icon);
			legendRow.createSpan({ text: entry.desc });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
