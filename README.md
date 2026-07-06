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

## Network use & requirements

**Network use.** The plugin makes exactly one kind of outbound connection: a
WebSocket to **your own self-hosted server**, at the `ws://` address you enter in
settings, over your **Tailscale** tailnet. It contacts **no third-party or cloud
service**, sends **no telemetry or analytics**, and does not self-update. All
Claude API traffic originates from *your server*, not from the plugin.

**Account / external service required.** Full functionality requires
infrastructure you run yourself:
- a host running the bundled **SDK server** with **Claude Code installed and signed
  in on your Claude subscription** (the server makes the Claude calls), and
- **Tailscale** on the server and every client device.

Without these the plugin is an empty sidebar — it cannot talk to Claude on its own.

**Unofficial.** This is an independent, community project. It is **not affiliated
with, endorsed by, or sponsored by Anthropic**. "Claude" is a trademark of
Anthropic; it is used here only to describe what the plugin connects to.

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
cp packages/server/occ-server.env.example ~/.config/occ-server.env
chmod 600 ~/.config/occ-server.env
# edit it: set OCC_TOKEN (openssl rand -hex 32) and OCC_HOST (the Tailscale IP)

# Install the systemd unit:
sudo cp packages/server/occ-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now occ-server.service
journalctl -u occ-server -f      # should log: listening on ws://<tailscale-ip>:8765
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
  running on the server. The plugin auto-reconnects when the app returns to the
  foreground (and via a heartbeat that detects sockets the OS killed silently); on
  reconnect it clears and replays the buffered transcript — including your last
  message — then resumes the live tail.
- **Server restart (Level-1 resume):** the in-flight turn is lost (the query runs
  in the server process), but the conversation is restored by resuming the
  session on the next attach.
- **CLI coexistence:** a session can move between the plugin and a terminal, but
  only one may write at a time — see [CLI interoperability & locking](#cli-interoperability--locking).
- The **server must stay running** for sessions to be live. Vault edits the agent
  makes converge to your other devices via your normal file sync (Obsidian Sync,
  etc.) — this project does not sync files itself.

## CLI interoperability & locking

The server runs with `cwd` = the canonical vault path, so its sessions are stored in
the **same place** the `claude` CLI uses (`~/.claude/projects/<vault>/`). A session can
therefore move between the Obsidian plugin and a terminal — but only **one** of them may
*write* at a time, or the on-disk transcript forks. Rather than try to merge, the plugin
enforces this with a **read-only** model.

**Resuming across plugin ⇄ CLI**

- `claude --resume <id>` in the vault continues a plugin session, and vice-versa.
- The CLI's interactive `/resume` *picker* only lists CLI-started sessions (it filters by
  `entrypoint`), so plugin-created sessions are resumable by id but won't show there — use
  the picker's kebab → **Copy shell resume command** to grab `claude --resume <id>`.

**Read-only when a CLI holds the session**

- If a session you have open is also open in a terminal, the plugin goes **fully
  read-only** (composer + Send disabled, 🔒 banner). There is **no override** — this is
  deliberate, so a fork is impossible.
- Detection is **on demand, never polled**: the plugin checks for CLI activity only when
  you *open/reload* a session and when you *try to send* (the server refuses the send if a
  CLI is live). It never auto-clears or auto-reloads.
- To regain control: close the terminal session, then press **Reload** in the banner.
  Reload re-reads the transcript from disk and re-checks for a CLI; if none is active, the
  session becomes writable again. (Picking any session from the list always reloads from
  disk, too.)

**Clean hand-off to the terminal**

- **Copy shell resume command** also *closes* the session in the plugin (returns to the
  empty state) and releases the server's hold on it, so the terminal gets a clean,
  sole-owner session.
- A session left idle with no plugin view attached is released after ~5 minutes, so the
  server stops being a writer your terminal would conflict with.

**Among plugin clients** (sidebar + extra tabs + other devices) a single-writer rule also
applies — extra views attach in a mirrored, read-only mode (an *eye* badge) and the server
refuses a second writer until the first releases it.

**How CLI activity is detected:** the server reads Claude Code's live-process registry
(`~/.claude/sessions/*.json`), scoped to this vault's working dir and ignoring its own
query subprocesses (a `/proc` ancestry check). It is best-effort — if that registry is
absent or unreadable, no lock is applied.

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
change fans out across protocol → server → plugin layers). See
[`TECHNICAL_DECISIONS.md`](TECHNICAL_DECISIONS.md) for the design rationale and the
verified SDK facts.

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
(`benjmin-r/obsidian-claude-chat`) — BRAT pulls the assets from the latest release.
`.github/workflows/ci.yml` runs the test suites + build on every push/PR.

## License

MIT.
