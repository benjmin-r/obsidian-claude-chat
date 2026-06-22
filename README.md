# Claude Chat for Obsidian

A **structured** Claude chat inside Obsidian — markdown bubbles, streamed
text/thinking, tool & todo display, and **auto-apply-edits / confirm-only-deletes**
permission prompts — backed by the [Claude Agent SDK](https://docs.claude.com)
running on your own always-on host and reached over [Tailscale](https://tailscale.com).

This replaces the earlier tmux terminal relay: instead of streaming a raw TUI to
a sidebar, the server owns long-lived Agent-SDK sessions and speaks a small JSON
protocol to a purpose-built Obsidian plugin.

> **This is self-hosted.** There is no cloud service. You run the server; your
> devices reach it privately over your tailnet.

## What you need (three components)

1. **The Obsidian plugin** (`packages/plugin`) — installed in each device's vault.
   Mobile-safe (DOM + WebSocket only).
2. **The SDK server** (`packages/server`) — a small Node service on an always-on
   host that has **Claude Code installed and authenticated on your subscription**
   and a **synced copy of the vault**. It owns the sessions.
3. **Tailscale** — on the server *and* every client device. The server binds to
   its Tailscale IP only; clients connect over the tailnet. **It is not reachable
   off-tailnet by design.**

```
 Obsidian (desktop / mobile)            always-on host
 ┌───────────────────────┐   ws://     ┌─────────────────────────────┐
 │  Claude Chat plugin    │ ─────────▶  │  SDK server  ──▶  query()    │
 │  (sidebar view)        │  tailnet    │  (owns sessions)  Agent SDK  │
 └───────────────────────┘   +token    └─────────────────────────────┘
        vault (file sync) ⇄ … ⇄ vault on the host
```

## Repository layout (npm workspaces monorepo)

```
packages/
  protocol/   PURE shared wire types + SDK→event mapping + destructive predicate
  server/     Agent SDK service (ports-and-adapters; session actors; WS transport)
  plugin/     Obsidian plugin (ItemView chat, bridge client, settings)
docs/PLAN.md  the design of record
```

`plugin` and `server` both import the wire types from `protocol`, so the
protocol has a single source of truth (no client/server drift).

## Setup

### 1. Server (on the always-on host)

The host must already have Claude Code installed and signed in on your
subscription (`claude` runs and `query()` reports `apiKeySource: none`), and a
copy of the vault synced to `OCC_VAULT_CWD`.

```bash
git clone <this repo> ~/projects/obsidian-claude-chat
cd ~/projects/obsidian-claude-chat
npm install
npm run build        # builds protocol → server → plugin

# Configure the token + bind address (never commit this file):
cp packages/server/claude-anywhere-sdk.env.example ~/.config/claude-anywhere-sdk.env
chmod 600 ~/.config/claude-anywhere-sdk.env
# edit it: set OCC_TOKEN (openssl rand -hex 32) and OCC_HOST (the Tailscale IP)

# Install the systemd unit:
sudo cp packages/server/claude-anywhere-sdk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-anywhere-sdk.service
journalctl -u claude-anywhere-sdk -f      # should log: listening on ws://<tailscale-ip>:8765
```

**Security notes**
- The server **refuses to bind to `0.0.0.0`/`::`** — set `OCC_HOST` to the
  Tailscale IP. Traffic stays inside WireGuard, so `ws://` (not `wss://`) is fine.
- Every connection must present the bearer token on `hello`; bad tokens are
  rejected and the socket is closed.
- `ANTHROPIC_API_KEY` must stay **unset** in the service env, or the SDK switches
  from your subscription to metered API billing. The unit deliberately omits it.

### 2. Tailscale

Install Tailscale on the host and on every client device, `tailscale up` on each,
and make sure the SDK port is reachable within your ACLs (tag the host if you use
tag-based ACLs). Nothing else needs to be exposed.

### 3. Plugin (in each vault)

Copy the three build artifacts into your vault's plugin folder:

```
<vault>/.obsidian/plugins/claude-chat/
  main.js        (packages/plugin/main.js)
  manifest.json  (packages/plugin/manifest.json)
  styles.css     (packages/plugin/styles.css)
```

Enable **Claude Chat** in *Settings → Community plugins*, then open
*Settings → Claude Chat* and set:
- **Server URL** — `ws://<host>.<tailnet>.ts.net:8765` (or the Tailscale IP)
- **Bearer token** — the same `OCC_TOKEN` as the server
- **Default model** — defaults to Opus 4.8

These fields are shown on **all platforms** (including mobile). Open the chat
from the ribbon (message icon) or the *Open Claude chat* command.

## Usage, resume & limitations

- **Streaming:** assistant text and thinking stream in incrementally (with a
  cursor), never buffered until the turn completes.
- **Permissions:** edits/reads/creates auto-apply; destructive shell operations
  (`rm`, `mv`, truncating `>`, `git reset --hard`, …) pause for an **Allow/Deny**
  prompt in the sidebar.
- **Client disconnects / mobile background (Level-2 resume):** the session keeps
  running on the server; reconnecting replays the buffered transcript and then
  the live tail.
- **Server restart (Level-1 resume):** the in-flight turn is lost (the query runs
  in the server process), but the conversation is restored by resuming the
  session on the next attach.
- **CLI interop:** because the server runs with `cwd` = the canonical vault path,
  sessions are stored in the same place as the `claude` CLI, so
  **`claude --resume <id>`** in the vault continues a sidebar session (and
  vice-versa). Note: the CLI's interactive `/resume` *picker* lists only
  CLI-started sessions (it filters by `entrypoint`), so SDK-created sessions are
  resumable by id but won't appear in that list — the plugin's picker has a
  "copy `claude --resume <id>`" button for exactly this.
- **Single-writer rule:** drive a session from one place at a time. Extra clients
  attach in a mirrored, read-only mode (a *(mirroring)* badge); the server
  refuses a second writer until the first releases it. Don't drive the same
  session from the sidebar and `claude --resume` simultaneously.
- The **server must stay running** for sessions to be live. Vault edits the agent
  makes converge to your other devices via your normal file sync (Obsidian Sync,
  etc.) — this project does not sync files itself.

## Development

```bash
npm test            # all three packages (Jest), enforces ≥80% coverage
npm run build       # type-check + emit (protocol/server dist, plugin main.js)
npm run lint        # where configured
```

- `protocol` is pure and tested to ~100%.
- `server` uses ports-and-adapters: `SessionActor`/`SessionManager`/`Connection`
  take injected deps (a `runQuery` port, a clock, an event sink) and are
  unit-tested with no real SDK and no socket. `sdk-adapter.ts` and
  `ws-transport.ts` are thin I/O shells.
- `plugin` keeps its logic in the pure `view-model` reducer and the injectable
  `bridge-client`, both unit-tested against fakes; `chat-view.ts` is the thin DOM
  layer.

**New here (human or AI)?** Read [`AGENTS.md`](AGENTS.md) first — it has the
architecture invariants and the "anatomy of a feature" checklist (why a serious
change fans out across protocol → server → plugin layers). See `docs/PLAN.md` for
the full design rationale and the verified SDK facts.

## Releasing the plugin (GitHub Actions)

`.github/workflows/release.yml` builds the plugin and publishes a GitHub Release
with `main.js`, `manifest.json`, `styles.css` attached — the format BRAT and the
Obsidian community store expect. To cut a release:

```bash
# 1. bump "version" in packages/plugin/manifest.json (+ add the entry to versions.json)
# 2. tag it (the tag MUST equal the manifest version) and push:
git tag 0.1.0
git push origin 0.1.0
```

The workflow verifies the tag matches the manifest version, then creates the
release. **Mobile install via BRAT:** in Obsidian (works on iOS/Android), install
the *BRAT* community plugin, "Add beta plugin", and enter this repo
(`<owner>/obsidian-claude-chat`) — BRAT pulls the assets from the latest release.
`.github/workflows/ci.yml` runs the test suites + build on every push/PR.

## License

MIT.
