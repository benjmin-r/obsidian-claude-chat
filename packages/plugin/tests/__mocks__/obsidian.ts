/**
 * Comprehensive mock of Obsidian API for testing
 * Based on the Obsidian API and common usage patterns
 */

// Add Obsidian-specific methods to HTMLElement
declare global {
	interface HTMLElement {
		empty(): void;
		createEl<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			options?: { text?: string; cls?: string; value?: string; attr?: Record<string, string> }
		): HTMLElementTagNameMap[K];
		createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLDivElement;
		createSpan(options?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLSpanElement;
		addClass(...classes: string[]): void;
		removeClass(...classes: string[]): void;
		toggleClass(cls: string, value: boolean): void;
		setText(text: string): void;
		setAttr(name: string, value: string): void;
	}
}

// Implement Obsidian-specific DOM methods
if (typeof HTMLElement !== "undefined") {
	HTMLElement.prototype.empty = function () {
		this.innerHTML = "";
	};

	HTMLElement.prototype.createEl = function (tag, options = {}) {
		const el = document.createElement(tag);
		if (options.text) el.textContent = options.text;
		if (options.cls) el.className = options.cls;
		if (typeof (options as { value?: string }).value === "string") {
			(el as unknown as { value: string }).value = (options as { value: string }).value;
		}
		if (options.attr) {
			Object.entries(options.attr).forEach(([key, value]) => {
				el.setAttribute(key, value);
			});
		}
		this.appendChild(el);
		return el;
	};

	HTMLElement.prototype.createDiv = function (options = {}) {
		return this.createEl("div", options);
	};

	HTMLElement.prototype.createSpan = function (options = {}) {
		return this.createEl("span", options);
	};

	HTMLElement.prototype.addClass = function (...classes: string[]) {
		this.classList.add(...classes);
	};

	HTMLElement.prototype.removeClass = function (...classes: string[]) {
		this.classList.remove(...classes);
	};

	HTMLElement.prototype.toggleClass = function (cls: string, value: boolean) {
		this.classList.toggle(cls, value);
	};

	HTMLElement.prototype.setText = function (text: string) {
		this.textContent = text;
	};

	HTMLElement.prototype.setAttr = function (name: string, value: string) {
		this.setAttribute(name, value);
	};
}

export class WorkspaceLeaf {
	setViewState = jest.fn().mockResolvedValue(undefined);
	detach = jest.fn();
	view: unknown = null;
}

export class Component {
	load = jest.fn();
	unload = jest.fn();
	registerEvent = jest.fn();
	registerDomEvent = jest.fn();
	registerInterval = jest.fn();
	addChild = jest.fn();
}

export class View extends Component {
	app: App;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.app = new App();
		this.containerEl = document.createElement("div");
	}
}

export class ItemView extends View {
	contentEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl = document.createElement("div");
	}
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	getIcon(): string {
		return "";
	}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

export const MarkdownRenderer = {
	render: jest.fn().mockImplementation(async (_app: unknown, markdown: string, el: HTMLElement) => {
		el.textContent = markdown;
	}),
};

export function setIcon(el: HTMLElement, iconId: string): void {
	el.setAttribute("data-icon", iconId);
}

export function addIcon(_id: string, _svg: string): void {
	// no-op
}

export class App {
	vault = {
		adapter: {
			exists: jest.fn().mockResolvedValue(false),
			read: jest.fn().mockResolvedValue(""),
			write: jest.fn().mockResolvedValue(undefined),
			remove: jest.fn().mockResolvedValue(undefined),
			mkdir: jest.fn().mockResolvedValue(undefined),
		},
		create: jest.fn().mockResolvedValue({}),
		createFolder: jest.fn().mockResolvedValue(undefined),
		modify: jest.fn().mockResolvedValue(undefined),
		delete: jest.fn().mockResolvedValue(undefined),
		getAbstractFileByPath: jest.fn().mockReturnValue(null),
		getMarkdownFiles: jest.fn().mockReturnValue([]),
		getFiles: jest.fn().mockReturnValue([]),
		read: jest.fn().mockResolvedValue(""),
	};

	workspace = {
		getActiveFile: jest.fn().mockReturnValue(null),
		getActiveViewOfType: jest.fn().mockReturnValue(null),
		openLinkText: jest.fn().mockResolvedValue(undefined),
		getLeavesOfType: jest.fn().mockReturnValue([]),
		getRightLeaf: jest.fn().mockReturnValue(new WorkspaceLeaf()),
		revealLeaf: jest.fn().mockResolvedValue(undefined),
		on: jest.fn(),
		off: jest.fn(),
	};

	metadataCache = {
		getFileCache: jest.fn().mockReturnValue(null),
		getCache: jest.fn().mockReturnValue(null),
	};

	fileManager = {
		processFrontMatter: jest.fn(),
		renameFile: jest.fn().mockResolvedValue(undefined),
	};
}

export class Plugin {
	app: App;
	manifest = {
		id: "test-plugin",
		name: "Test Plugin",
		version: "0.0.1",
		minAppVersion: "0.15.0",
		description: "Test plugin",
		author: "Test Author",
		authorUrl: "",
		isDesktopOnly: false,
		dir: "/test/plugin/dir",
	};

	constructor() {
		this.app = new App();
	}

	loadData = jest.fn().mockResolvedValue({});
	saveData = jest.fn().mockResolvedValue(undefined);
	addCommand = jest.fn();
	addSettingTab = jest.fn();
	registerView = jest.fn();
	registerInterval = jest.fn().mockReturnValue(1);
	registerEvent = jest.fn();
	addRibbonIcon = jest.fn().mockReturnValue({
		addClass: jest.fn(),
		removeClass: jest.fn(),
		setAttr: jest.fn(),
		remove: jest.fn(),
	});
}

export class Notice {
	message: string;
	duration?: number;

	constructor(message: string, duration?: number) {
		this.message = message;
		this.duration = duration;
		console.log(`Notice: ${message}${duration ? ` (${duration}ms)` : ""}`);
	}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl: HTMLElement;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = document.createElement("div");
	}

	display(): void {
		// Override in implementation
	}

	hide(): void {
		// Override in implementation
	}
}

export class Setting {
	private settingEl: HTMLElement;
	private nameEl: HTMLElement;
	private descEl: HTMLElement;
	private controlEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		this.nameEl = document.createElement("div");
		this.descEl = document.createElement("div");
		this.controlEl = document.createElement("div");
		this.settingEl.appendChild(this.nameEl);
		this.settingEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.textContent = desc;
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.className = cls;
		return this;
	}

	addText(cb: (text: TextComponent) => void): this {
		const text = new TextComponent(this.controlEl);
		cb(text);
		return this;
	}

	addToggle(cb: (toggle: ToggleComponent) => void): this {
		const toggle = new ToggleComponent(this.controlEl);
		cb(toggle);
		return this;
	}

	addDropdown(cb: (dropdown: DropdownComponent) => void): this {
		const dropdown = new DropdownComponent(this.controlEl);
		cb(dropdown);
		return this;
	}

	addTextArea(cb: (textArea: TextAreaComponent) => void): this {
		const textArea = new TextAreaComponent(this.controlEl);
		cb(textArea);
		return this;
	}

	addButton(cb: (button: ButtonComponent) => void): this {
		const button = new ButtonComponent(this.controlEl);
		cb(button);
		return this;
	}
}

export class TextComponent {
	inputEl: HTMLInputElement;
	private value = "";

	constructor(containerEl: HTMLElement) {
		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		containerEl.appendChild(this.inputEl);
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	getValue(): string {
		return this.value;
	}

	onChange(cb: (value: string) => void): this {
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			cb(this.value);
		});
		return this;
	}
}

export class TextAreaComponent {
	inputEl: HTMLTextAreaElement;
	private value = "";

	constructor(containerEl: HTMLElement) {
		this.inputEl = document.createElement("textarea");
		containerEl.appendChild(this.inputEl);
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	getValue(): string {
		return this.value;
	}

	onChange(cb: (value: string) => void): this {
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			cb(this.value);
		});
		return this;
	}
}

export class ToggleComponent {
	toggleEl: HTMLInputElement;
	private value = false;

	constructor(containerEl: HTMLElement) {
		this.toggleEl = document.createElement("input");
		this.toggleEl.type = "checkbox";
		containerEl.appendChild(this.toggleEl);
	}

	setValue(value: boolean): this {
		this.value = value;
		this.toggleEl.checked = value;
		return this;
	}

	getValue(): boolean {
		return this.value;
	}

	onChange(cb: (value: boolean) => void): this {
		this.toggleEl.addEventListener("change", () => {
			this.value = this.toggleEl.checked;
			cb(this.value);
		});
		return this;
	}
}

export class DropdownComponent {
	selectEl: HTMLSelectElement;
	private value = "";

	constructor(containerEl: HTMLElement) {
		this.selectEl = document.createElement("select");
		containerEl.appendChild(this.selectEl);
	}

	addOption(value: string, display: string): this {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = display;
		this.selectEl.appendChild(option);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		Object.entries(options).forEach(([value, display]) => {
			this.addOption(value, display);
		});
		return this;
	}

	setValue(value: string): this {
		this.value = value;
		this.selectEl.value = value;
		return this;
	}

	getValue(): string {
		return this.value;
	}

	onChange(cb: (value: string) => void): this {
		this.selectEl.addEventListener("change", () => {
			this.value = this.selectEl.value;
			cb(this.value);
		});
		return this;
	}
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	private clickHandler?: () => void;

	constructor(containerEl: HTMLElement) {
		this.buttonEl = document.createElement("button");
		containerEl.appendChild(this.buttonEl);
	}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	setCta(): this {
		this.buttonEl.classList.add("mod-cta");
		return this;
	}

	setWarning(): this {
		this.buttonEl.classList.add("mod-warning");
		return this;
	}

	onClick(cb: () => void): this {
		this.clickHandler = cb;
		this.buttonEl.addEventListener("click", cb);
		return this;
	}
}

export class Modal {
	app: App;
	contentEl: HTMLElement;
	titleEl: HTMLElement;

	constructor(app: App) {
		this.app = app;
		this.contentEl = document.createElement("div");
		this.titleEl = document.createElement("div");
	}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {
		// Override in implementation
	}

	onClose(): void {
		// Override in implementation
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class TFile {
	path: string;
	basename: string;
	extension: string;
	stat = {
		ctime: Date.now(),
		mtime: Date.now(),
		size: 0,
	};

	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		const filename = parts[parts.length - 1];
		const dotIndex = filename.lastIndexOf(".");
		this.basename = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
		this.extension = dotIndex > 0 ? filename.substring(dotIndex + 1) : "";
	}
}

export class TFolder {
	path: string;
	name: string;

	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1];
	}
}

export interface MarkdownView {
	file: TFile;
	editor: Editor;
}

export interface Editor {
	getValue(): string;
	setValue(value: string): void;
	getSelection(): string;
	replaceSelection(replacement: string): void;
	getCursor(): { line: number; ch: number };
	setCursor(pos: { line: number; ch: number }): void;
}
