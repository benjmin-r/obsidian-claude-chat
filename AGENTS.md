# AGENTS.md

Guidelines for AI agents (Claude, GPT, etc.) and developers working in this repo.
**Read this first.**

This is a structured Obsidian chat on the Claude Agent SDK: a server owns
long-lived sessions; the plugin is a detachable view. npm-workspaces monorepo.

## Packages

- **`packages/protocol`** — pure, dependency-free: the JSON-over-WebSocket wire
  types, SDK→event mappers, and predicates. Imported by **both** server and
  plugin. The **single source of truth** for the protocol.
- **`packages/server`** — the Agent-SDK service. Ports-and-adapters: a pure-ish
  core (`SessionActor` / `SessionManager` / `Connection`) driven by **injected
  dependencies**, plus thin I/O shells (`sdk-adapter.ts` wraps the SDK,
  `ws-transport.ts` wraps the socket).
- **`packages/plugin`** — the Obsidian plugin. A pure `view-model` reducer + an
  injectable `bridge-client` hold the logic; `chat-view.ts` / `main.ts` are thin
  Obsidian/DOM shells.

## Core invariants (don't break these)

1. **Protocol is the single source of truth.** Every client↔server message/event
   is a type in `packages/protocol`, imported by both sides. Never hand-write a
   message shape in only one package. (TDL-20260617-002.)
2. **Ports-and-adapters.** Side effects (SDK calls, sockets, clock, file I/O) are
   injected as *ports* and implemented in thin shells; the core takes them as
   constructor deps so it is unit-testable with fakes. (TDL-20260617-003.)
3. **Pure cores are tested; I/O shells are not.** ≥80% coverage per package;
   `sdk-adapter.ts`, `ws-transport.ts`, `index.ts`, `chat-view.ts`, `main.ts` are
   excluded as shells.

## Anatomy of a feature (READ THIS)

**Any feature that moves data between the server and client fans out across
layers. This is by design — a direct consequence of invariants 1 & 2 — not
incidental.** For a client→server action with a server→client result (e.g.
session rename, resume), expect to touch most of these, in order:

1. `protocol/src/messages.ts` — add the message/event to the discriminated
   union(s). If it transforms SDK data, add a pure mapper in `map-sdk-events.ts`
   (with a unit test).
2. `server/src/ports.ts` — add a port type if it needs a new side effect.
3. `server/src/sdk-adapter.ts` — implement that port against the real SDK (shell).
4. `server/src/session-manager.ts` (or `session-actor.ts`) — the actual logic,
   using injected deps (unit-tested).
5. `server/src/connection.ts` — handle the inbound message; route to the core;
   send result events.
6. `server/src/ws-transport.ts` — add the message `type` to the
   `parseClientMessage` allowlist.
7. `server/src/index.ts` — wire any new port into the manager deps.
8. `plugin/src/bridge-client.ts` — add a typed send method.
9. `plugin/src/view-model.ts` — handle any new render event in the pure reducer
   (unit-tested).
10. `plugin/src/chat-view.ts` — the DOM/UI.
11. **Tests** — the pure pieces (protocol mappers, view-model reducer,
    manager/connection with fakes) + the parser allowlist.
12. Rebuild, deploy, and add a **TDL entry** if it's a notable decision.

Smaller changes touch fewer layers: a pure view tweak is `view-model` +
`chat-view`; a style fix is just `styles.css`. The list above is the **maximal
path**, not a mandate for trivial changes — use judgment.

**Why the fan-out is worth it:** no client/server drift (one protocol) and a
fully unit-testable core (injected deps). If you find yourself wanting to skip
`protocol` and inline a message shape, or call the SDK directly from the core —
stop; that breaks the invariants.

## File & folder conventions

- **Keep `main.ts` minimal** — plugin lifecycle only (`onload`/`onunload`,
  `registerView`, commands, settings tab). No feature logic.
- **Single responsibility per module.** If a file exceeds ~200–300 lines, split
  it into focused modules.
- **Put logic in pure modules** (protocol mappers, the view-model reducer, the
  session core) and keep DOM/SDK/socket in shells — this is what keeps the
  testable surface large.

## Obsidian patterns

- **Register listeners so they're cleaned up on unload.** Prefer
  `this.registerEvent(...)`, `this.registerDomEvent(window/document, ...)`, and
  `this.registerInterval(window.setInterval(...))`. Raw `addEventListener` on
  `window`/`document` (or timers) must be torn down manually in `onClose`.
- **Stable IDs.** Don't rename command/view IDs once released.
- **Settings:** persist via `loadData()`/`saveData()` with
  `Object.assign({}, DEFAULT_SETTINGS, …)`; validate user input; show every field
  on all platforms (no desktop-only gating — mobile users need the server URL +
  token).

## Security & privacy

This plugin is more network-capable than a typical Obsidian plugin (it drives a
remote agent), so be deliberate:

- **One network destination:** the self-hosted SDK server, over a
  **token-authenticated WebSocket** on the user's **Tailscale** tailnet. No
  third-party services, no telemetry, no analytics.
- **Never fetch-and-eval remote code** or auto-update outside normal releases.
- **Minimize vault scope.** The plugin reads only its own settings; the agent's
  file access happens **server-side** and is gated by the confirm-only-deletes
  permission policy.
- **Secrets:** the bearer token lives in the plugin's `data.json` (gitignored)
  and in the server's env file (chmod 600) — never in the repo. The server must
  never log message content or the token; `ANTHROPIC_API_KEY` stays unset.
- Bind the server to the Tailscale IP only (it refuses `0.0.0.0`).

## Performance

- Keep startup light; defer heavy work out of `onload`.
- Debounce/throttle work triggered by frequent events.
- Be mindful of memory on mobile; avoid unbounded in-memory growth (the server's
  replay buffer is capped for this reason).

## Mobile

- The plugin is **DOM + `WebSocket` only** (no Node APIs) so it runs on
  iOS/Android; `manifest.json` has `isDesktopOnly: false`. Keep it that way.
- Test on iOS/Android where feasible; don't assume desktop layout/keyboard.

## UX & copy

- **Sentence case** for headings, buttons, titles.
- Clear, action-oriented imperatives in step-by-step copy.
- **Bold** for literal UI labels; prefer "select"; arrow notation for navigation
  (**Settings → Community plugins**).
- Keep in-app strings short, consistent, jargon-free.

## Testing & code quality

- `npm test` runs all packages; `npm run test:coverage` enforces **≥80%**.
- The server uses `tsconfig.test.json` for tests so `@occ/protocol` resolves to
  source across packages.
- Formatting via Prettier (`.prettierrc`); match the surrounding style.
- Write tests for the **pure** pieces; don't chase coverage on I/O shells (they're
  excluded) — verify those with a quick live/integration check instead.

## Technical Decision Log (TDL)

Record significant decisions in `TECHNICAL_DECISIONS.md` (root), simplified-ADR
format, reverse-chronological, ≤200 words per entry. See that file's header for
the exact `TDL-YYYYMMDD-NNN` shape.

**MUST document:** an alternative chosen over others; deviations from the plan;
actual API/SDK behaviour vs expected; breaking changes; non-obvious bug fixes;
perf optimizations; **new npm dependencies**.
**DO NOT document:** routine work that follows the plan, style tweaks, trivial
fixes, behaviour-preserving refactors, comment/doc edits.

**Lifecycle:** `Implemented` → `Superseded by TDL-XXX` → `Deprecated`. Add the
entry *before* implementing a non-obvious decision.

**Using the log:** read `TECHNICAL_DECISIONS.md` first; when asked "why is X like
this?", search it and cite the TDL-ID; before changing something, check it
doesn't contradict an entry (if it does, surface the conflict).

## Development workflow

1. Build with `npm run build` (**protocol → server → plugin**; order matters).
2. Run `npm test` / `npm run test:coverage`.
3. Verify behaviour — unit tests for pure logic, plus a live check for the SDK/
   socket shells (e.g. a scripted WebSocket client against the running server).
4. **Wait for maintainer verification** before considering a change done.
5. Commit locally with a clear message; end commit messages with the project's
   co-author trailer.
6. **Do not `git push` without explicit maintainer approval** — each push is
   gated; prior approval does not carry to the next one.

## More docs

- `TECHNICAL_DECISIONS.md` — the decision log (why things are the way they are).
- `docs/PLAN.md` — the design of record + verified SDK facts.
- `docs/TESTING.md` — the PoC test walkthrough, known limitations, feedback template.
- `README.md` — what it is, the components, and setup.
