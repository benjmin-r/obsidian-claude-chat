# Plan: Agent-SDK structured Obsidian chat (standalone build plan)

Self-contained plan. Supersedes `agent-sdk-plan.md` (archive it). `followup-plan.md`
and `initial-plan.md` are historical only — **not needed to execute this.**

## Context
We built and deployed a tmux-backed terminal relay (in `obsidian-claude/server/`)
that streams a `claude` TUI to an Obsidian sidebar over Tailscale. It works and
resumes well, but the **raw-terminal UX is poor**. Decision: build a **structured
chat** — markdown bubbles, streamed text/thinking, tool/todo display, and
**auto-apply-edits / confirm-only-deletes** permission prompts — on the **Claude
Agent SDK**, with an **own Obsidian plugin**. Everything below was either verified
on the vserver or decided in review (Benjamin's 4 inline comments + follow-ups).

## Decisions locked in review
- **Relay:** decommission on the vserver **now**; **extract its code to its own
  `claude-anywhere-fork` repo** (PR-ready fork of derek-larson14/obsidian-claude-anywhere).
- **Streaming:** responses stream **incrementally** (not buffered-till-complete).
- **Repo:** new **monorepo** (npm workspaces) `protocol/` + `server/` + `plugin/`,
  plugin based on `/home/USER/projects/obsidian-plugin-template`.
- **Testability:** ports-and-adapters; pure logic cores; injected SDK/WS; enforce
  ≥80% coverage (template already does).
- This plan is the **design of record**; `agent-sdk-plan.md` is superseded.

---

## Verified environment & SDK facts (tested on `your-host`, 2026-06-17)
- **Env:** Node v22.22.2, npm 10.9.7, claude 2.1.179, `@anthropic-ai/claude-agent-sdk`
  **v0.3.179** (Node ≥18). Vault `/home/USER/vaults/VAULT`. Tailscale
  `100.64.0.1` / `your-host.your-tailnet.ts.net`, node tagged
  `tag:relay` (key expiry off).
- **Auth = subscription, NO API key** (`query()` reported `apiKeySource: none`).
  Keep `ANTHROPIC_API_KEY` **unset** in the service env (if set it wins → metered
  API). Headless re-auth if ever needed: `claude setup-token`.
- **Billing:** SDK + `claude -p` currently draw from the subscription pool; the
  announced June-15 separate-credit change was **paused** (Help Center 15036540).
- **Sessions:** stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
  (`<encoded-cwd>` = abs path, non-alphanumerics → `-`). **Shared with the CLI —
  verified:** an SDK-created session was resumed via `claude -p --resume <id>` from
  the vault and recalled prior context. `cwd` MUST match the canonical vault path
  or resume silently starts fresh.
- **Resume opts:** `resume:<id>`, `continue:true`, `forkSession:true`,
  `persistSession:false`. Enumerate the store with `listSessions()` /
  `getSessionMessages()` / `getSessionInfo()` / `renameSession()` / `tagSession()`.
- **Capture id:** TS — `session_id` on the init `SystemMessage` and every `result`.
- **canUseTool:** `(toolName, input, {toolUseID, signal, suggestions, title, …}) =>
  Promise<{behavior:"allow", updatedInput, updatedPermissions?} | {behavior:"deny",
  message}>`.
- **permissionMode:** `default | acceptEdits | bypassPermissions | dontAsk | plan |
  auto`. We use **`default`** so every tool routes through `canUseTool`.
- **Events:** `system`(init), `assistant`, `partial_assistant`(text delta),
  `thinking_tokens`, `tool_use_summary`, `tool_progress`, `permission_denied`,
  `result`(subtype `success|error_max_turns|error_max_budget_usd|error_*`).
- **Streaming input / long-lived session:** pass an `AsyncIterable<SDKUserMessage>`
  as `prompt`; the query stays alive across yielded messages and **keeps running
  independent of whether its output is being consumed** → suits a server-owned
  persistent session. `query.interrupt()` cancels.

---

## Architecture

### Load-bearing principle
**The server owns long-lived `query()` sessions; the plugin is a detachable view.**
A `query()` runs in a server-side session actor driven by an async-generator input
queue and keeps running whether or not a client is attached. The server buffers
emitted events; a reconnecting client gets a snapshot + live tail → **Level-2
resume across client disconnects**. (Caveat: the query runs *in the server
process*, so a **server restart** loses in-flight turns; on next attach we
`resume:<id>` for Level-1 transcript reload. Full restart-survival would need a
child-process-per-session supervisor — deferred, see Open decisions.)

### Monorepo layout (`/home/USER/projects/obsidian-claude-chat`)
```
obsidian-claude-chat/
  package.json                     # npm workspaces: packages/*
  packages/
    protocol/                      # PURE: shared types + mappers + predicates
      src/{messages.ts, map-sdk-events.ts, is-destructive.ts}
      tests/...
    server/                        # Agent SDK service (Node/TS)
      src/{index.ts, session-manager.ts, session-actor.ts,
           sdk-adapter.ts, ws-transport.ts, permission-policy.ts, config.ts}
      tests/...
      claude-anywhere-sdk.service  # systemd unit
    plugin/                        # Obsidian plugin (from the template)
      src/{main.ts, chat-view.ts, bridge-client.ts, settings.ts, settings-types.ts}
      tests/__mocks__/obsidian.ts  # from template
      manifest.json, styles.css, esbuild.config.mjs, jest.config.cjs, tsconfig.json
```
`plugin` and `server` both import wire types from `protocol` → **single source of
truth for the protocol** (prevents the drift that bit the stock plugin).

### `protocol` package (pure, ~100% coverage)
- `messages.ts` — discriminated-union types for the WS bridge (below).
- `map-sdk-events.ts` — pure `mapSdkEvent(sdkMsg) => BridgeEvent[]`.
- `is-destructive.ts` — pure `isDestructive(toolName, input) => boolean`.

### `server` package
**Session model.** A `SessionManager` holds `SessionActor`s keyed by SDK
`session_id`. Each `SessionActor`:
- owns one `query({ prompt: <async generator>, options })`, consumed by the server;
- input queue: client `user_message` → pushed to the generator;
- event **ring buffer** of normalized bridge events for replay-on-attach;
- status: `idle | working | awaiting_permission`;
- pending-permission map `toolUseID → resolve` (client `permission_decision`
  resolves the `canUseTool` promise);
- knows its `cwd` (canonical vault path) and model.

Clients **attach** by id or start **new_session**; on attach the server sends
`session_status` + buffered-event replay, then live events. Multiple clients may
attach (mirrored); **single-writer** input enforced/advised.

**`query()` invocation:**
```ts
query({
  prompt: sessionInputGenerator(),            // AsyncIterable<SDKUserMessage>
  options: {
    cwd: "/home/USER/vaults/VAULT",     // canonical → CLI interop + resume
    model: "claude-opus-4-8",                  // configurable (default)
    permissionMode: "default",                 // route every tool to canUseTool
    canUseTool,
    includePartialMessages: true,              // ← incremental text streaming
    resume: priorSessionId,                    // only when reconstructing after restart
  }
})  // ANTHROPIC_API_KEY intentionally unset in the process env → subscription
```

**Permissions — auto-apply edits, confirm only deletes:**
```ts
const canUseTool = async (toolName, input, { toolUseID }) => {
  if (isDestructive(toolName, input)) {                 // from protocol (pure)
    return await actor.requestPermission(toolUseID, toolName, input); // awaits client
  }
  return { behavior: "allow", updatedInput: input };    // auto-allow edits/creates/reads
};
```
`requestPermission` stores `toolUseID → resolve`, emits `permission_request`;
client `permission_decision` resolves to `{behavior:"allow",updatedInput}` or
`{behavior:"deny",message}`. While awaiting → status `awaiting_permission` (waits
patiently if the client is away).

**Streaming:** responses stream **incrementally** — `partial_assistant` deltas map
to `assistant_text_delta` events rendered live (cursor), never
buffered-until-complete. (Resolves the review comment.)

**Bridge protocol (JSON over WebSocket):**
- **server → client:** `ready`, `assistant_text_delta`, `thinking_delta`,
  `tool_use`, `tool_result`, `todo_update`, `permission_request`, `done`(carry
  `session_id`, subtype), `error`, `sessions_list`, `session_status`.
- **client → server:** `hello`(+ bearer token, optional `attach: session_id`),
  `user_message`, `permission_decision`, `interrupt`, `new_session`,
  `resume_session`(by id), `list_sessions`.
- Mapping: `partial_assistant`→`assistant_text_delta`; `thinking_tokens`→
  `thinking_delta`; assistant tool_use→`tool_use`; tool results→`tool_result`;
  `result`→`done`; todo updates→`todo_update`; SDK errors→`error`;
  `interrupt`→`query.interrupt()`.

**Auth & security:** subscription (no API key; unit must not set
`ANTHROPIC_API_KEY`; `HOME=/home/USER`). **Bind to the Tailscale IP only**
(never `0.0.0.0`). **App-level bearer token** validated on `hello`. `ws://` over
the tailnet is fine (WireGuard). Port: 8765 is freed by the relay decommission;
pick 8765 or a fresh port (Open decision).

**Ops:** `server/package.json` deps `@anthropic-ai/claude-agent-sdk` + `ws`;
systemd unit `claude-anywhere-sdk.service` (`User=USER`, WorkingDirectory=vault,
`Environment=HOME=/home/USER`, PATH incl. node+claude+tailscale, **no
`ANTHROPIC_API_KEY`**, `Restart=always`, `After=tailscaled.service`). Node logs to
journald. (`KillMode=process` does NOT save in-flight work here — query is
in-process; restart → Level-1 resume.)

### `plugin` package (own TS, from the template)
Mobile-safe: **DOM + `WebSocket` only**, no Node APIs.
- `manifest.json` — own id/name; `isDesktopOnly:false`, `minAppVersion 1.4.0`.
- `src/main.ts` — `registerView`, ribbon, "Open Claude chat" command, settings
  tab; open in right sidebar.
- `src/chat-view.ts` — `ChatView extends ItemView`: render via
  `MarkdownRenderer.render`; live `assistant_text_delta`/`thinking_delta` (cursor);
  `tool_use`/`tool_result` blocks + `todo_update` list; **delete-confirmation
  prompt** on `permission_request` (Allow/Deny → `permission_decision`); model
  dropdown; connection + **session-status** badge; **session list / reattach**
  (new, reattach existing, status badge for single-writer hand-off).
- `src/bridge-client.ts` — `WebSocket` client to the SDK service; **bearer token**;
  reconnect/backoff; `attach`/`resume_session`; maps protocol events ↔ view.
- `src/settings.ts` / `settings-types.ts` — server URL **shown on all platforms**
  (fixes the stock plugin's desktop-only-field gotcha), bearer token (password),
  default model, reconnect behavior; `DEFAULT_SETTINGS`.
- `styles.css`; **no** `@anthropic-ai/*` in the plugin.
- Reuse template patterns: `loadData/saveData` + `Object.assign(DEFAULT_SETTINGS,…)`,
  `PluginSettingTab` with `containerEl.empty()` + re-`display()`. ItemView +
  WebSocket are new (template has neither).

### Resume model
- **Client disconnect / mobile background:** session keeps running; reconnect →
  `attach` → snapshot + live tail (**Level-2**).
- **Server restart:** in-flight turn lost; next attach does `resume:<id>` →
  conversation restored (**Level-1**); registry rebuilt via `listSessions()`.
- **CLI interop (verified):** `cwd`=vault ⇒ `claude --resume` sees sidebar
  sessions and vice-versa.
- **Single-writer rule:** never drive one session from sidebar *and* `claude
  --resume` at once; status badge guards hand-off; server can refuse a 2nd writer.

### Testability & test strategy (ports-and-adapters)
- **`protocol` (pure, ~100%):** type unions; pure `mapSdkEvent`; pure
  `isDestructive`. Highest-value, trivial unit tests, no I/O.
- **`server`:** `SessionActor` takes **injected deps** — a `runQuery` fn (real =
  SDK `query`, test = async-generator mock), a `now()` clock, an event `sink`.
  Unit-test the input queue, ring-buffer + **replay-on-attach**, permission
  promise resolution, status transitions — **without real SDK or socket**.
  `sdk-adapter.ts` (wraps `query`) and `ws-transport.ts` (`ws` server) are thin
  I/O shells → a few integration tests. `permission-policy.ts` delegates to the
  pure `isDestructive`.
- **`plugin`:** `bridge-client.ts` (event↔view mapping, reconnect, attach/resume)
  unit-tested against a **fake WebSocket** (template mock style); keep view-state
  logic separable from DOM.
- **Enforce ≥80% coverage** per package (template already does) in `npm test`/CI.

---

## Execution steps (on approval)

### A — Decommission the relay on the vserver (first)
```bash
sudo systemctl stop claude-anywhere-relay
sudo systemctl disable claude-anywhere-relay
sudo rm -f /etc/systemd/system/claude-anywhere-relay.service
sudo systemctl daemon-reload
tmux -L claude-anywhere kill-server
```
Verify: service not-found; `ss -ltn | grep 8765` empty; `tmux -L claude-anywhere
ls` no server. Note the decommission in `followup-plan.md` build-status.

### B — Extract relay → `claude-anywhere-fork` repo (PR-ready)
- New repo `/home/USER/projects/claude-anywhere-fork`, seeded from upstream
  (preserve upstream files + LICENSE/attribution to Derek Larson).
- Apply our `relay_server.py` changes (tmux Level-2 layer, `--bind`/`--port`).
  **Generalize for upstream:** drop the hardcoded `~/.local/share/npm/bin/claude`
  from `find_claude()` (keep PATH fallback); keep vault/OS-agnostic.
- Re-embed via upstream `build.sh` (base64 → `main.js`); README documents the
  Level-2 detach/reattach feature + `KillMode=process` caveat.
- Remove `obsidian-claude/server/` (history stays in git). Opening a PR to Derek
  is optional/later.

### C — Supersede `agent-sdk-plan.md`
- Add a header to `obsidian-claude/agent-sdk-plan.md` marking it **superseded by
  this standalone plan**; remove the resolved `<benjamin>` comment blocks.
- This plan is copied into the new monorepo as its spec (`docs/PLAN.md`).

### D — Scaffold the monorepo from the template
- New repo **`/home/USER/projects/obsidian-claude-chat`**; `git init`; npm
  workspaces `packages/*`.
- Copy template into `packages/plugin/`; fix paths to be package-local:
  `esbuild.config.mjs` entry, `jest.config.cjs` roots, `tsconfig.json` `baseUrl`,
  `dev-watch.sh`. Keep template Jest + `obsidian` mock + 80% thresholds.
- Add ts-jest setups for `server/` and `protocol/`. Root scripts (`build`, `test`,
  `test:coverage`, `lint`) fan out across workspaces.

### Build phases (testing woven in)
1. `protocol` types + pure `mapSdkEvent`/`isDestructive` **+ unit tests** (TDD).
2. Server skeleton: WS + token auth + one `query()` streaming text to a scripted
   client (proves subscription auth in a real service).
3. `SessionManager`/`SessionActor`: persistent session, queue, event buffer,
   attach/replay (Level-2) — unit-tested via injected deps.
4. Permissions: `canUseTool` + `permission_request` round-trip.
5. Plugin MVP: chat view, streaming render, send, settings (URL+token, all
   platforms).
6. Plugin permissions + session UX (delete prompt, session list/reattach, badges).
7. Resume/restart + CLI-interop hardening, systemd unit, security check.
8. **End-user documentation** (see Step E).

### E — End-user installation docs (deliverable)
This is a **self-hosted, multi-component** system, so ship docs aimed at someone
installing it from scratch — a top-level `README.md` plus a `packages/plugin`
README:
- **What it is + the components required:** (1) the **Obsidian plugin** (installed
  in each device's vault), (2) the **SDK server** running on an always-on host that
  has Claude Code installed + authenticated (subscription) and a synced copy of the
  vault, (3) **Tailscale** on the server and every client device.
- **Tailscale requirement (call out prominently):** server + all clients on the
  same tailnet; the server binds to its Tailscale IP only; clients connect to
  `ws://<host>.<tailnet>.ts.net:<port>` with the bearer token; **not reachable
  off-tailnet by design**.
- **Setup steps:** *server* — clone the monorepo, `npm install`, build, set bearer
  token + bind address, install the systemd unit; *Tailscale* — install, `up`, ACL/
  tag for the port; *plugin* — install `main.js`/`manifest.json`/`styles.css` into
  the vault, set server URL + token in settings (shown on all platforms).
- **Usage, resume behavior, and limitations:** server must stay running; vault
  edits the agent makes converge to other devices via the user's file sync
  (Obsidian Sync, etc.); single-writer rule for CLI hand-off.

---

## Critical files / paths
- **Decommission:** `/etc/systemd/system/claude-anywhere-relay.service`; tmux
  socket `claude-anywhere`.
- **Relay source to extract:** `obsidian-claude/server/` (`relay_server.py`,
  `claude-anywhere-relay.service`, `README.md`).
- **Template:** `/home/USER/projects/obsidian-plugin-template` (`esbuild.config.mjs`,
  `jest.config.cjs`, `tests/__mocks__/obsidian.ts`, `src/main.example.ts`,
  `src/example-settings.ts`, `dev-watch.sh`, 80% coverage thresholds).
- **New repos:** `claude-anywhere-fork/`, `obsidian-claude-chat/` (monorepo).
- **Superseded:** `obsidian-claude/agent-sdk-plan.md`.

## Verification
- **Relay decommissioned:** service not-found; `:8765` closed; tmux server gone.
- **Fork repo:** `python3 -m py_compile relay_server.py`; `build.sh` re-embeds;
  README documents Level-2; LICENSE/attribution intact.
- **Monorepo bootstrap:** root `npm install` resolves workspaces; `npm test` green
  across all three packages with coverage ≥ thresholds; `packages/plugin` builds a
  `main.js`.
- **End-to-end (per phase):** bad token rejected; `new_session` + `user_message`
  "list my notes" → streamed `tool_use`/`assistant_text_delta`/`done`; delete →
  `permission_request` → allow trashes / deny doesn't; drop WS mid-turn → reattach
  replays + continues (Level-2); `systemctl restart` → reattach restores via
  `resume` (Level-1, in-flight lost); CLI interop both directions; off-tailnet
  unreachable on the SDK port (ss bind check + public-IP refuse + external probe);
  plugin Jest (bridge-client mapping + delete round-trip) + build clean.
- **Docs:** the end-user `README.md` walks a fresh setup (server + Tailscale +
  plugin) end-to-end, naming all three components and the Tailscale requirement.

## Open build-time decisions
- **Server-restart resume depth:** Level-1 (simpler, recommended start) vs
  child-process-per-session for Level-2 across restarts.
- **"Destructive" set** for confirm-only-deletes (Bash `rm`/`mv`/`>` truncate;
  `Write` overwriting an existing file? git destructive ops?) — start conservative.
- **Default model:** `claude-opus-4-8` (configurable).
- **SDK service port:** 8765 (now free) or a fresh one.
