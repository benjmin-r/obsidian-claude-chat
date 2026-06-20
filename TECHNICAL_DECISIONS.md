# Technical Decisions Log

This file tracks significant technical decisions made during development, using a
simplified ADR format. Entries are in reverse chronological order (newest first).
Each entry is ≤200 words.

---

## TDL-20260620-001: Connection-level logging in the WS transport

**Date:** 2026-06-20
**Status:** Implemented
**Context:** Operators running the server need to diagnose client issues, but the service logged only its startup line.
**Decision:** Log connection lifecycle and inbound message *types* (and error events) in the `ws-transport` shell; never log message content or the bearer token.
**Alternatives:**

- Full request/response logging — rejected: leaks prompt content and is noisy.
- A structured logging dependency — rejected: overkill for a PoC; `console` → journald is enough.

**Consequences:**

- `journalctl` shows `#N connected / <- <type> / -> error: … / disconnected`.
- Logging lives in the I/O shell, so the pure core stays side-effect-free and unit-tested.

**Files:**

- `packages/server/src/ws-transport.ts`

---

## TDL-20260617-010: Ship releases via GitHub Actions for BRAT

**Date:** 2026-06-17
**Status:** Implemented
**Context:** Users (incl. mobile) need a way to install/update the plugin from the repo without a desktop build step.
**Decision:** A tag-triggered Actions workflow builds the plugin and publishes a GitHub Release with `main.js`/`manifest.json`/`styles.css` attached, the format BRAT and the community store expect; the tag must equal the manifest version.
**Alternatives:**

- Manual release uploads — rejected: error-prone, easy to mismatch versions.
- Commit built assets to the repo — rejected: noisy diffs; BRAT works from releases.

**Consequences:**

- Monorepo subfolder is fine: release assets are path-independent.
- CI workflow also runs tests + build on push/PR.

**Files:**

- `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `packages/plugin/versions.json`

---

## TDL-20260617-009: Build the plugin from the Obsidian plugin template

**Date:** 2026-06-17
**Status:** Implemented
**Context:** We need an own, mobile-capable Obsidian plugin rather than reusing a terminal-relay plugin.
**Decision:** Base the plugin on the standard Obsidian plugin template (esbuild + Jest + the `obsidian` mock, 80% coverage), adding an `ItemView` chat surface and a `WebSocket` client — neither of which the template ships.
**Alternatives:**

- Fork an existing terminal-relay plugin — rejected: raw-terminal UX and message-shape drift.
- Build with a UI framework (React/Svelte) — rejected: extra bundle/complexity; DOM is enough.

**Consequences:**

- DOM + `WebSocket` only (no Node APIs), so it runs on mobile.
- View logic lives in a pure reducer; `chat-view.ts` is a thin DOM layer.

**Files:**

- `packages/plugin/src/{main.ts,chat-view.ts,view-model.ts,settings.ts}`

---

## TDL-20260617-008: Two-level resume + single-writer sessions

**Date:** 2026-06-17
**Status:** Implemented
**Context:** Mobile clients disconnect often, and a session may be opened from several devices.
**Decision:** The server buffers transcript events per session for replay-on-attach (Level-2, survives client disconnects); after a server restart, a session is reconstructed via SDK `resume:<id>` (Level-1, in-flight turn lost). One client writes; others mirror read-only.
**Alternatives:**

- Child-process-per-session supervisor for Level-2 across restarts — deferred: added complexity.
- Last-writer-wins multi-writer — rejected: interleaved input corrupts a turn.

**Consequences:**

- Reconnect replays buffer then live tail; a restart drops only the current turn.
- A `(mirroring)` badge signals read-only; the server refuses a second writer.

**Files:**

- `packages/server/src/{session-actor.ts,session-manager.ts,connection.ts}`

---

## TDL-20260617-007: Incremental streaming of text and thinking

**Date:** 2026-06-17
**Status:** Implemented
**Context:** Buffering a full reply before showing it feels unresponsive.
**Decision:** Enable `includePartialMessages` and map `content_block_delta` events to `assistant_text_delta` / `thinking_delta`, rendered live with a cursor.
**Alternatives:**

- Render only the final `assistant`/`result` message — rejected: poor perceived latency.

**Consequences:**

- The pure mapper does not re-emit text from the later full message (avoids duplication).
- The plugin reducer folds consecutive deltas into one bubble.

**Files:**

- `packages/protocol/src/map-sdk-events.ts`, `packages/plugin/src/view-model.ts`

---

## TDL-20260617-006: Auto-apply edits, confirm only deletes

**Date:** 2026-06-17
**Status:** Implemented
**Context:** Routing every tool to a prompt is noisy; auto-allowing everything is unsafe.
**Decision:** Run with `permissionMode: "default"` so all tools pass through `canUseTool`; a pure `isDestructive` predicate confirms only clearly destructive shell ops (`rm`, `mv`, truncating `>`, `git reset --hard`, force-push, …) and auto-applies reads/edits/writes.
**Alternatives:**

- `acceptEdits` mode — rejected: doesn't gate destructive shell commands.
- Confirm everything / `bypassPermissions` — rejected: noisy / unsafe.

**Consequences:**

- Conservative by design: when unsure, ask. The destructive set is small and explicit, easy to extend.
- Destructive tools pause the turn (`awaiting_permission`) until the client decides.

**Files:**

- `packages/protocol/src/is-destructive.ts`, `packages/server/src/session-actor.ts`

---

## TDL-20260617-005: Tailscale-only bind + bearer token, no TLS

**Date:** 2026-06-17
**Status:** Implemented
**Context:** The server exposes a powerful agent; it must not be reachable from the public internet.
**Decision:** Bind to the host's Tailscale IP only (config refuses `0.0.0.0`/`::`), authenticate every connection with an app-level bearer token on `hello`, and use plain `ws://` since the tailnet is already WireGuard-encrypted.
**Alternatives:**

- Public bind + TLS + auth — rejected: larger attack surface; unnecessary inside a tailnet.
- No token (rely on network only) — rejected: defense in depth.

**Consequences:**

- Unreachable off-tailnet by design; requires Tailscale on server + clients.
- Adds `ws` as a server dependency.

**Files:**

- `packages/server/src/{config.ts,connection.ts,ws-transport.ts}`

---

## TDL-20260617-004: Use the Claude subscription, never an API key

**Date:** 2026-06-17
**Status:** Implemented
**Context:** Setting `ANTHROPIC_API_KEY` silently switches the Agent SDK to metered API billing.
**Decision:** Authenticate via the subscription session in `~/.claude`; keep `ANTHROPIC_API_KEY` unset in the service environment and document it prominently.
**Alternatives:**

- API key auth — rejected: unexpected metered billing for a personal-use server.

**Consequences:**

- The systemd unit must not set the key; `HOME` must point at the account holding the creds.
- Adds `@anthropic-ai/claude-agent-sdk` as the core server dependency.

**Files:**

- `packages/server/src/{config.ts,sdk-adapter.ts}`, `packages/server/claude-anywhere-sdk.service`

---

## TDL-20260617-003: Ports-and-adapters with injected dependencies

**Date:** 2026-06-17
**Status:** Implemented
**Context:** The SDK and sockets are hard to unit-test directly, but the session logic is the risky part.
**Decision:** The session core takes injected ports — a `runQuery` function, a clock, an event sink — so input queue, ring-buffer replay, permission round-trips and status transitions are tested with fakes; the real SDK and `ws` live in thin shells.
**Alternatives:**

- Integration-test against the real SDK/socket — rejected: slow, flaky, costs tokens.

**Consequences:**

- `≥80%` coverage per package; `sdk-adapter.ts` and `ws-transport.ts` excluded as I/O shells.

**Files:**

- `packages/server/src/{ports.ts,session-actor.ts,session-manager.ts,connection.ts}`

---

## TDL-20260617-002: Monorepo with a shared `protocol` package

**Date:** 2026-06-17
**Status:** Implemented
**Context:** A separate client and server that exchange JSON tend to drift in message shape over time.
**Decision:** Use npm workspaces with a pure `protocol` package (wire types, SDK→event mapper, destructive predicate) imported by both server and plugin — a single source of truth for the protocol.
**Alternatives:**

- Duplicate types in each package — rejected: drift (the failure mode of the earlier relay plugin).
- Publish `protocol` to npm — rejected: unnecessary overhead for one repo.

**Consequences:**

- Build order: `protocol` first; the plugin only type-imports it (no runtime bundle cost).
- Tests resolve `@occ/protocol` to source via jest `moduleNameMapper`.

**Files:**

- `packages/protocol/*`, root `package.json`

---

## TDL-20260617-001: Server-owned Agent-SDK sessions; plugin is a view

**Date:** 2026-06-17
**Status:** Implemented
**Context:** We want structured chat (streamed text/thinking, tool/todo display, permission prompts) reachable from mobile, where running the SDK client-side is impossible.
**Decision:** A server process owns long-lived `query()` sessions on the Claude Agent SDK; the Obsidian plugin is a thin, detachable client over a JSON-over-WebSocket bridge.
**Alternatives:**

- SDK in the plugin — rejected: no Node on mobile; secrets on the device.
- Terminal relay (stream a `claude` TUI) — rejected: poor raw-terminal UX.

**Consequences:**

- Enables reconnect/resume and multi-device mirroring (the session outlives any client).
- The query runs in-process, so a server restart loses the in-flight turn (see TDL-20260617-008).

**Files:**

- `packages/server/src/{index.ts,session-actor.ts,sdk-adapter.ts}`

---

<!-- Add new entries above this line, in reverse chronological order (newest first) -->
<!-- When this file reaches 50 entries, archive older entries to docs/tdl-archive/ -->
