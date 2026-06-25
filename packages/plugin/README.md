# Claude Chat (Obsidian plugin)

The Obsidian half of [Claude Chat](../../README.md): a structured Claude chat in
a sidebar, backed by a self-hosted Claude Agent SDK server reached over Tailscale.

This plugin is **only the view**. It does not run Claude itself — it connects to
the SDK **server** over a WebSocket on your tailnet. You need all three
components (plugin + server + Tailscale); see the [top-level README](../../README.md).

## Install

Copy the build artifacts into your vault:

```
<vault>/.obsidian/plugins/claude-chat/
  main.js        # produced by `npm run build` in this package
  manifest.json
  styles.css
```

Enable **Claude Chat** under *Settings → Community plugins*.

## Settings (shown on all platforms, including mobile)

| Setting          | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| Server URL       | `ws://<host>.<tailnet>.ts.net:8765` of the SDK server          |
| Bearer token     | Must match `OCC_TOKEN` on the server (stored masked)           |
| Default model    | Model used for new sessions (default Opus 4.8)                 |
| Auto-reconnect   | Reconnect with backoff when the connection drops               |
| Reconnect delay  | Base backoff in ms                                             |

## Using it

- Open from the ribbon (message icon) or the **Open Claude chat** command.
- Type and press **Enter** to send (**Shift+Enter** for a newline).
- **New** starts a fresh session; **list** requests the server's session list;
  the stop icon interrupts the current turn.
- Assistant text and thinking stream in live. Tool calls and their results render
  as blocks; the TodoWrite list renders above the transcript.
- Destructive tools (deletes, overwrites) pause for an **Allow / Deny** prompt.
- The status icons show the connection state and session activity; an **eye** icon
  marks a read-only view (another client holds the writer role for the session).

## Internals

- `view-model.ts` — pure state reducer (delta folding, tool/result pairing,
  permission + status tracking). Unit-tested.
- `bridge-client.ts` — WebSocket client with injectable socket + scheduler;
  reconnect/backoff, attach/resume, event mapping. Unit-tested against a fake
  socket.
- `chat-view.ts` — thin `ItemView` DOM layer rendering the view-model state.
- `settings.ts` / `settings-types.ts` — settings tab + defaults.

DOM + WebSocket only; no Node APIs, so it runs on mobile.
