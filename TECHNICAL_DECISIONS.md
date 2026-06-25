# Technical Decisions Log

This file tracks significant technical decisions made during development, using a
simplified ADR format. Entries are in reverse chronological order (newest first).
Each entry is ≤200 words (longer when a hard-won investigation is worth preserving).

---

## TDL-20260625-001: Mobile on-screen-keyboard composer positioning

**Date:** 2026-06-25
**Status:** Implemented

**Context:** On the iOS app the composer left a large block of dead space below it
whenever the on-screen keyboard was up, and the message area collapsed. The
composer stayed *functional* (above the keyboard) but looked broken. The root
cause took a long investigation because Obsidian's iOS webview presents the
keyboard in the **native layer**, invisible to the web: with the keyboard open we
measured `window.innerHeight`, `visualViewport.height`, `100dvh`, `100svh`,
`document.documentElement.clientHeight` and `screen.height` *all* still reporting
the full 812px, and `env(keyboard-inset-height)` reporting `0`. Yet WebKit
internally compresses our flex layout (the messages area shrank 453→177px and the
composer lifted) — so the keyboard affects layout but exposes no value to read.

**What we ruled out (each verified on-device, not theorised):**

- **Height-chain / flex-fill CSS** (force `.workspace-leaf-content` into a
  full-height flex column, `flex:1 1 auto` on `.view-content`). No effect — the
  height chain was never the problem; the view already filled its leaf.
- **`visualViewport` sizing.** `vv.height` stays 812 with the keyboard up, so
  there is nothing to react to.
- **`interactive-widget=resizes-content`** on the viewport `<meta>`. Applied
  successfully (confirmed in the computed meta) but Obsidian's WKWebView ignores
  it — `vv` still 812.
- **`env(keyboard-inset-height)` / VirtualKeyboard API.** Chromium-only;
  `navigator.virtualKeyboard` is absent in iOS WebKit, so the env var is always 0.
- **Explicitly sizing the container** to `innerHeight − keyboardHeight − top`
  (once we had the height; see below). *Necessary but not sufficient:* even in a
  correctly-sized 418px box the composer floated to the top (`rowB=140`), because
  **`flex:1` does not distribute free space while the keyboard is up in this
  webview.** This is the key non-obvious fact — any layout that relies on
  flex-grow to push the composer down is doomed here. (`margin-top:auto` is no
  escape: auto margins out-rank flex-grow and would break the normal-case fill.)

Kept from an earlier pass (orthogonal, still useful): `:empty { display:none }`
on the todos/permission/activity slots, which removed dead space in *empty*
sessions but not the keyboard case.

**Decision:** Two parts.

1. **Get the keyboard height from the native bridge.** Obsidian's mobile shell
   (Capacitor/cordova-ionic-keyboard) dispatches `keyboardWillShow` /
   `keyboardDidShow` / `keyboardWillHide` / `keyboardDidHide` on `window`, and the
   show events carry `e.keyboardHeight` in px. This is the *only* reliable signal
   and it does fire for plugins (measured `keyboardHeight=344`). It is
   undocumented for Obsidian plugin authors, so treat it as best-effort: if the
   events never fire, nothing breaks (we just keep the normal layout).

2. **Lay the composer out explicitly while the keyboard is open**, instead of
   trusting flexbox. On show we set `.view-content` height to
   `innerHeight − keyboardHeight − top` (so it ends exactly at the keyboard top —
   this also absorbs the ~110px of Obsidian bottom chrome automatically, since
   `top` and `innerHeight` are real) and add `.occ-kb-open`. That class switches
   to absolute positioning: the composer is pinned `bottom: 8px`, and the messages
   become a definite, scrollable band via `top: var(--occ-msg-top)` /
   `bottom: var(--occ-msg-bottom)` (toolbar height + 8, composer height + 18, set
   from JS). On hide we strip the class, height, and vars — reverting to the
   normal flex layout that works fine on desktop and when the keyboard is down.

**Consequences:**

- Depends on an **undocumented** Obsidian/Capacitor `window` keyboard event. If a
  future Obsidian release stops firing it, the composer reverts to the (still
  usable, just gappy) flex behaviour — no hard failure.
- The explicit absolute layout is **mobile-keyboard-only**; desktop and
  keyboard-down are untouched.
- Edge cases while the keyboard is open and a permission prompt / session picker
  appears are not specially handled (those slots are in normal flow behind the
  absolute composer); rare enough to defer.
- Spacing is two literals (`bottom: 8px`, messages `+18px`); tune if the feel is
  off.

**Files:** `plugin/src/chat-view.ts` (`setKeyboardInset`, the `keyboard*` window
listeners), `plugin/styles.css` (`.occ-kb-open` rules).

---

## TDL-20260624-003: Composer/UX polish — Escape capture, `@`-suggest, link routing, rename propagation

**Date:** 2026-06-24
**Status:** Implemented
**Context:** A batch of daily-use UX gaps: Obsidian's global Escape hotkey stole
focus/switched tabs from the composer; assistant-message links and a typed `@`
file reference were inert; a "mirroring" badge confused more than it helped; and
plugin renames were suspected not to reach `claude --resume`.
**Decision:**

- **Escape:** swallow it in a capture-phase listener on the view root so it never
  reaches Obsidian's keymap. Menus/Modals render outside `contentEl`, so theirs
  still work. The `@`-popover dismiss is folded into this one handler.
- **`@`-mention picker:** a self-contained controller over the `<textarea>` —
  `AbstractInputSuggest` only supports `<input>`/contenteditable. Pure
  `findMentionQuery`/`spliceMention` helpers are unit-tested; matching reuses
  `prepareFuzzySearch`.
- **Vault links:** one delegated click handler resolves `data-href`/`href` via
  `metadataCache.getFirstLinkpathDest`; real URLs fall through.
- **Mirroring badge:** removed (UI only) — the server single-writer lock stays.
- **Rename:** verified `renameSession` appends `custom-title` and `listSessions`
  derives the title from it; no code change. A running CLI shows it on next launch
  (it snapshots its list), not mid-session.

**Consequences:** Escape is inert in an empty composer (intentional). `renameSession`
only appends to an existing on-disk session.
**Files:** plugin `{chat-view,file-suggest}.ts`, `styles.css`.

---

## TDL-20260624-002: Mobile-resilient WebSocket transport

**Date:** 2026-06-24
**Status:** Implemented
**Context:** On iPad, backgrounding Obsidian suspends the plugin JS and the OS kills
the socket without delivering `onclose`, so the connection never recovered.
Foregrounding then spawned duplicate sockets + repeated "WebSocket error" notices,
and a reconnect's buffer-replay dropped the last (optimistic) user message.
**Decision:**

- **Heartbeat:** client pings every 15s; >35s with no inbound frame ⇒ a dead-but-open
  socket ⇒ force-reconnect. `checkAlive()` actively probes on foreground.
- **Foreground recovery:** reconnect on `visibilitychange`/`focus`/`online`; `connect()`
  is idempotent while CONNECTING/OPEN (no duplicate sockets); one in-flight probe.
- **Quiet errors:** transport `onerror` no longer raises a Notice — the connection icon
  conveys state; only server/app errors notify.
- **`attach_reset`:** the actor emits it first on every (re)attach so the client clears
  before the buffer replay (no duplicated history on reconnect).
- **Buffer the user turn:** `enqueue` persists a `user_echo` to the replay buffer
  *without broadcasting* (the live client already shows it optimistically — no dupe),
  so a reconnect replays the full user+answer exchange.

**Consequences:** a brief flicker (clear-then-replay) on re-attach; a transient
non-writer state is possible until a zombie connection is reaped.
**Files:** plugin `{bridge-client,chat-view}.ts`, server `{session-actor,connection,
ws-transport}.ts`, protocol `messages.ts` (ping/pong, attach_reset).

---

## TDL-20260624-001: Read-only-while-CLI-active + reload (replaces staleness guard)

**Date:** 2026-06-24
**Status:** Implemented (supersedes TDL-20260622-002)
**Context:** The granular concurrent-writer guard (content-staleness via message-count
baselines, `session_stale`, rebaseline-on-done, send override/`force`, a "Send anyway"
modal) was too complex and produced false-positive banners + confusing precedence in
device testing.
**Decision:** A simpler, predictable model:

- **A session open in a live CLI ⇒ the plugin is fully read-only** (text box + Send
  disabled, no override). The server refuses the send too (`sendGate`).
- **Freshness via reload, not diffing:** picking a session **always reloads** from disk;
  a read-only session offers a **Reload** button that re-reads and re-checks CLI presence
  — writable again only if no CLI is active.
- **On-demand detection only:** CLI activity is checked at load (`resumeWithHistory`
  immediate `detect`) and at send (`sendGate`). **No periodic poll** — read-only never
  clears or reloads on its own (explicit user requirement).
- **Clean hand-off:** "Copy shell resume command" also closes the current session and
  releases the actor (`close_session` → detach + drop-if-idle). Idle, detached actors are
  reaped after 5 min.

**Alternatives:** keep mtime/message-count staleness (too eager/complex); proactive poll
(user wanted on-demand only) — both rejected.
**Consequences:** a CLI that opens *after* load isn't shown until you send (then blocked)
or reload; best-effort (registry absent ⇒ no guard). All staleness machinery removed.
**Files:** server `{session-actor,session-manager,connection,sdk-adapter,index}.ts`,
protocol `messages.ts`, plugin `{view-model,chat-view,bridge-client}.ts`.

---

## TDL-20260622-002: Guard concurrent writers + reconcile stale sessions

**Date:** 2026-06-22
**Status:** SUPERSEDED by TDL-20260624-001 (this granular model proved too
complex/edge-case-prone in device testing; replaced by read-only + reload).
**Context:** A `SessionActor` holds one long-lived in-memory `query()`. If the same
session is continued in the CLI, the plugin (a) shows a stale transcript and (b)
can fork/corrupt the `.jsonl` by appending from stale context — even with no
concurrent process. There was no cross-process awareness.
**Decision:** Two signals, one gating surface.

- **External activity** (corruption guard): read Claude Code's live-process
  registry `~/.claude/sessions/*.json`, scoped to `cwd === vaultCwd`, pid-alive,
  excluding our own subprocess tree (`/proc` PPID walk). Severity `busy|idle|none`.
- **Staleness**: the on-disk **conversation-message count** (`getSessionMessages`)
  exceeds the actor's baseline — a foreign *turn* was added. (mtime/fileSize were
  too eager: an open CLI rewrites metadata/snapshots, which falsely tripped them.)
  Gated by a cheap mtime check; baseline re-established after each of our own turns.
  Independent of external activity, so a CLI that adds a turn shows "reload" even
  while still open.

Enforced at `enqueue` (server-authoritative) + mirrored in the plugin: **stale ⇒
block, no override** (persistent notice, must Reload first); **external busy/idle ⇒
block-with-override** ("send anyway"). Reading is never blocked. Reload = drop the
cached actor and re-resume from disk (`reloadSession`). Idle sessions with no
attached client are reaped after 5 min so we stop being a writer the user's own
CLI would conflict with.
**Alternatives:** server-pushes-fresh-transcript (actor-swap under live
connections) — rejected as risky; reload reuses the client resume path instead.
**Consequences:** best-effort (registry absent ⇒ no guard); a TOCTOU window
remains (caught by the next turn/poll); concurrent multi-client reload orphans
other clients until they re-interact.
**Files:** `packages/server/src/{external-activity,session-actor,session-manager,
connection,sdk-adapter}.ts`, `packages/plugin/src/{view-model,chat-view,bridge-client}.ts`.

---

## TDL-20260622-001: SDK sessions resume by id but aren't listed in the CLI picker

**Date:** 2026-06-22
**Status:** Implemented (workaround)
**Context:** SDK-created sessions don't appear in the shell `claude` interactive
`/resume` picker, despite living in the correct project dir — contradicting the
assumed seamless interop.
**Decision:** Diagnosed: the SDK tags its sessions `entrypoint: 'sdk-ts'`
(also `userType: 'external'`, `promptSource: 'sdk'`), and Claude Code's
interactive resume picker lists only `entrypoint: 'cli'` sessions. Resume **by id**
works — `claude --resume <id>` recalls context (verified). No SDK option exists to
change the entrypoint tag. Shipped a workaround: a "copy `claude --resume <id>`"
button per session in the plugin picker.
**Alternatives:**

- Rewrite the session JSONL's `entrypoint` to `'cli'` so the picker shows it —
  rejected: fragile (the SDK re-appends `sdk-ts` lines each turn, several fields
  may be filtered on, and it's brittle across SDK updates).

**Consequences:**

- SDK↔CLI interop is "resume by explicit id", not picker-listed. The README/PLAN
  "CLI interop verified" claim is narrowed accordingly.

**Files:**

- `packages/plugin/src/chat-view.ts`

---

## TDL-20260621-003: Keep the transcript pinned to the bottom reliably

**Date:** 2026-06-21
**Status:** Implemented
**Context:** The view rebuilds all messages on every event, and assistant bubbles render markdown asynchronously, so "scroll to bottom" landed above the last (async-sized) message — most visibly when switching into a session.
**Decision:** Treat "stick to bottom" as a persistent intent: force it true on new/resume/send; `render()` obeys the flag instead of re-deriving it. Only a genuine upward scroll (scrollTop decreasing) clears it; reaching the bottom re-sets it. A `ResizeObserver` on the message-content element plus timed re-pins (rAF/60ms/250ms) catch late layout growth.
**Alternatives:**
- Re-derive "follow" from `isNearBottom()` each render — rejected: carried the previous view's scroll position into the new session.
- Re-scroll in MarkdownRenderer's `.then` — rejected: resolves before layout; unreliable.
**Consequences:**
- The actual killer (took 3 attempts): the scroll listener set `stickBottom = isNearBottom()`, so async growth briefly read "not at bottom" and disabled follow mid-load. Direction-aware un-pin fixed it.
- A proper incremental renderer would remove most of this fragility (deferred).
**Files:**
- `packages/plugin/src/chat-view.ts`, `packages/plugin/styles.css`

---

## TDL-20260621-002: Lazy-load (page) resumed session history

**Date:** 2026-06-21
**Status:** Implemented
**Context:** Resuming a long session replayed the whole transcript — slow and heavy on mobile.
**Decision:** On resume, seed the actor's replay buffer with only the last page (~30 render events) and retain the older events server-side. Add a `load_older` request and a `history_page` event (`events` + `hasMore`); `session_status` carries `hasOlderHistory`. The plugin shows a "Load older messages" button, prepends fetched pages, and anchors scroll so the viewport doesn't jump.
**Alternatives:**
- Page at the SDK/message level with offsets — rejected: `getSessionMessages` returns the full array; paging our mapped render events is simpler and turn boundaries are close enough.
- Infinite auto-load on scroll — deferred: an explicit button is simpler/predictable.
**Consequences:**
- The server holds older events in memory for the session's life (same order as before).
- Prepend + async markdown can still shift slightly (shares the scroll-anchor caveat).
**Files:**
- `packages/protocol/src/messages.ts`, `packages/server/src/{session-actor,connection,ws-transport}.ts`, `packages/plugin/src/{view-model,chat-view,bridge-client}.ts`

---

## TDL-20260621-001: Transcript readability — copy, collapsible tools, scroll pill

**Date:** 2026-06-21
**Status:** Implemented
**Context:** On a phone the transcript was hard to scan and copy: verbose tool output, no copy affordance, and force-scroll fighting manual scrolling.
**Decision:** (1) A copy button per message bubble; rely on Obsidian's MarkdownRenderer for the native code-block copy button. (2) Tool calls render as a one-line, tappable header (name + input preview + error badge), collapsed by default, with expand state kept across re-renders. (3) When scrolled up, stop auto-scrolling and show a "Latest" pill that jumps to the bottom.
**Alternatives:**
- Add our own code-block copy button — rejected: Obsidian already adds one (duplicate buttons).
- Always-expanded tool output — rejected: noisy.
**Consequences:**
- Expanded-tool state lives in a `Set<toolUseId>` on the view.
**Files:**
- `packages/plugin/src/chat-view.ts`, `packages/plugin/styles.css`

---

## TDL-20260620-006: Code blocks scroll within themselves; prose wraps

**Date:** 2026-06-20
**Status:** Implemented
**Context:** Long lines/code in the narrow mobile sidebar produced horizontal scrollbars that scrolled the whole sidebar.
**Decision:** Wrap prose and inline code, but keep code BLOCKS as `white-space: pre; overflow-x: auto` so they scroll horizontally within themselves; constrain the containers (`min-width: 0`, `max-width: 100%`, `overflow-x: hidden` on the chat) so a block's scroll never widens the sidebar.
**Alternatives:**
- Wrap code too — rejected: destroys code alignment/formatting.
**Consequences:**
- The flexbox `min-width: 0` on bubbles is load-bearing; without it the block expands the layout.
**Files:**
- `packages/plugin/styles.css`

---

## TDL-20260620-005: Stable single-row icon toolbar + model menu

**Date:** 2026-06-20
**Status:** Implemented
**Context:** Text status badges reflowed and the toolbar wrapped to two lines on a small phone, with icons jumping as content changed.
**Decision:** One non-wrapping row with fixed slots — New, session picker, model, then right-pinned status. Connection and activity become SVG state icons (tap → a legend overlay). The model picker is a compact button opening an Obsidian `Menu`. The stop button reserves its slot (visible only mid-turn) so nothing shifts.
**Alternatives:**
- Keep text badges and a `<select>` — rejected: reflow and wasted width.
**Consequences:**
- Mirroring is folded into the activity icon (`eye`); fixed slots mean a state change never moves other controls.
**Files:**
- `packages/plugin/src/chat-view.ts`, `packages/plugin/styles.css`

---

## TDL-20260620-004: Session rename & delete via SDK mutations

**Date:** 2026-06-20
**Status:** Implemented
**Context:** Users need to retitle and remove sessions from the picker.
**Decision:** Add `rename_session`/`delete_session` messages backed by the SDK's `renameSession`/`deleteSession`; both reply with a refreshed `sessions_list`. Delete is gated by a confirm modal (irreversible) and also drops any live in-memory actor — otherwise it would keep running against a deleted store file. Store deletion is best-effort (a brand-new session may not be persisted yet).
**Alternatives:**
- Delete only the store file — rejected: a resumed session's actor would outlive its store.
**Consequences:**
- New `RenameStored`/`DeleteStored` ports; the manager drops the actor and the connection detaches if it was viewing it.
**Files:**
- `packages/protocol/src/messages.ts`, `packages/server/src/{ports,sdk-adapter,session-manager,connection}.ts`, `packages/plugin/src/chat-view.ts`

---

## TDL-20260620-003: Show a resumed (active) session's stored title

**Date:** 2026-06-20
**Status:** Implemented
**Context:** A `SessionActor` has no title of its own, so `listSummaries` listed active (resumed) sessions by UUID and filtered out the stored entry holding the renamed title — making a rename of an open session invisible (and it survived app quit because the actor stays alive).
**Decision:** In `listSummaries`, enrich each active session with its stored title (look it up by id) before deduping against stored-only entries.
**Alternatives:**
- Give the actor a title field synced on rename — rejected: more state to keep consistent; the store is the source of truth.
**Consequences:**
- Resumed sessions also stop showing raw UUIDs in the picker.
**Files:**
- `packages/server/src/session-manager.ts`

---

## TDL-20260620-002: Session picker — resume with transcript replay

**Date:** 2026-06-20
**Status:** Implemented
**Context:** The session-list button did nothing; users expected a `/resume`-style picker showing past sessions and their history.
**Decision:** Enumerate persisted sessions with the SDK's `listSessions({ dir })`; on resume, load `getSessionMessages` and map them with a new pure `mapHistoryMessages` so the prior transcript repaints. History needs assistant text and the user's own turns, so the mapper includes assistant text (unlike live streaming, which gets it via deltas) and emits a new `user_echo` render event. The dropdown refetches live on every open, with loading/stale/offline status.
**Alternatives:**
- Parse the `.jsonl` store directly — rejected: the SDK functions are robust and version-safe.
- Reuse the streaming mapper (skips assistant text) — rejected: history has no deltas, so text would be lost.
**Consequences:**
- `mapSdkEvent`'s assistant mapping gained an `includeText` flag.
**Files:**
- `packages/protocol/src/{messages,map-sdk-events}.ts`, `packages/server/src/{ports,sdk-adapter,session-manager}.ts`, `packages/plugin/src/{view-model,chat-view,bridge-client}.ts`

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
