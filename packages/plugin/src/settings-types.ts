/**
 * Plugin settings. Mobile-safe: every field is shown on ALL platforms (the
 * stock relay plugin hid the server-URL field on desktop-only, which was a
 * gotcha). No Node APIs here.
 */

export interface ClaudeChatSettings {
	/** ws:// URL of the SDK server on the tailnet, including port. */
	serverUrl: string;
	/** App-level bearer token presented on hello. */
	token: string;
	/** Default model for new sessions. */
	defaultModel: string;
	/** Reconnect automatically after a dropped connection. */
	autoReconnect: boolean;
	/** Base backoff in ms between reconnect attempts. */
	reconnectDelayMs: number;
	/**
	 * Show the on-screen-keyboard debug panel (a "Copy KB" button that copies a layout
	 * report to the clipboard). Off by default; enable to diagnose mobile keyboard/layout
	 * issues — see docs/MOBILE_KEYBOARD_DEBUG.md.
	 */
	debugKeyboardPanel: boolean;
}

export const DEFAULT_SETTINGS: ClaudeChatSettings = {
	serverUrl: "ws://your-host.your-tailnet.ts.net:8765",
	token: "",
	defaultModel: "claude-opus-4-8",
	autoReconnect: true,
	reconnectDelayMs: 1500,
	debugKeyboardPanel: false,
};

/** Models offered in the new-session dropdown. */
export const MODEL_OPTIONS: Record<string, string> = {
	"claude-opus-4-8": "Opus 4.8",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};
