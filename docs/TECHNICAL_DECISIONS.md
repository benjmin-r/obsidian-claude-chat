# Technical decisions

Status: **proof of concept.** This records the decisions taken while building the
first working version, and why. It complements `PLAN.md` (the design of record)
and is the place to look before changing load-bearing behaviour. ADR-ish, newest
concerns at the bottom of each section.

## Architecture

**The server owns long-lived `query()` sessions; the plugin is a detachable view.**
Each session runs in a server-side actor driven by an async-generator input queue
and keeps running whether or not a client is attached. The plugin is "just a
window" onto it. This is what makes reconnect/resume and multi-device mirroring
possible.

**Monorepo (npm workspaces): `protocol` + `server` + `plugin`.** The `protocol`
package holds the wire types, the SDK→event mapper, and the destructive-tool
predicate, and is imported by **both** server and plugin — a single source of
truth for the protocol, which prevents the client/server message drift that bit
the earlier relay plugin.

**Ports-and-adapters for testability.** The session core (`SessionActor`,
`SessionManager`, `Connection`) takes injected dependencies — a `runQuery` port,
a clock, an event sink/listener — so it is unit-tested with no real SDK and no
socket. `sdk-adapter.ts` (wraps the SDK `query()`) and `ws-transport.ts` (the
`ws` server) are thin I/O shells, excluded from coverage.

## Auth & billing

**Subscription, not API key.** The SDK authenticates against the Claude
subscription session in `~/.claude`. `ANTHROPIC_API_KEY` is deliberately left
**unset** in the service environment — if it were set, the SDK would silently
switch to metered API billing. `config.ts` does not read it and the systemd unit
does not set it. `HOME` is set so the creds are found.

## Transport security

- **Bind to the Tailscale IP only.** `config.ts` refuses `0.0.0.0`/`::`/`*`. The
  service is unreachable off the tailnet by design; `ws://` over WireGuard is
  fine, so no TLS is configured.
- **App-level bearer token**, validated on `hello` with a length-independent
  compare; bad tokens get an error and the socket is closed before any session
  access.
- The token lives in an `EnvironmentFile` (chmod 600), never in the unit or repo.

## Agent behaviour

- **Permissions: auto-apply edits, confirm only deletes.** `permissionMode` is
  `default`, so every tool routes through `canUseTool`. The pure `isDestructive`
  predicate returns true only for clearly destructive shell ops (`rm`, `rmdir`,
  `mv`, truncating `>`, `git reset --hard`, `git clean -f`, force-push, …);
  everything else (reads, `Edit`/`Write`/`MultiEdit`, read-only Bash) auto-applies.
  Conservative by design — when unsure, ask. Destructive tools pause the turn
  (`awaiting_permission`) until the client decides.
- **Incremental streaming.** `includePartialMessages: true`; `content_block_delta`
  text/thinking deltas are rendered live with a cursor, never buffered until the
  turn completes.
- **`cwd` = the canonical vault path.** Required for CLI interop and resume — an
  SDK-created session is resumable via `claude --resume <id>` and vice-versa.

## Resume & concurrency

- **Level-2 (client disconnect / mobile background):** the session keeps running;
  on reattach the server replays a ring buffer of transcript events, then the live
  tail.
- **Level-1 (server restart):** the in-flight turn is lost (the `query()` runs in
  the server process), but the conversation is restored by `resume:<id>` on the
  next attach. A child-process-per-session supervisor for Level-2-across-restart
  is **deferred**.
- **Single-writer.** One client drives a session; others attach mirrored/read-only
  (a `(mirroring)` badge). The server refuses a second writer until the first
  releases it. Never drive the same session from the sidebar and `claude --resume`
  at once.
- **Provisional→canonical session ids.** A new session starts under a provisional
  handle id; when the SDK `system/init` reports the real id, the manager aliases
  it so clients holding either id resolve to the same actor.

## Testing

- `protocol` is pure and tested to ~100%; the mapper and predicate have no I/O.
- `server` core is unit-tested via injected deps (input queue, ring-buffer replay,
  permission round-trip, status transitions, single-writer). `≥80%` coverage
  enforced per package.
- `plugin` keeps logic in the pure `view-model` reducer and the injectable
  `bridge-client` (tested against a fake socket + scheduler); `chat-view.ts` and
  `main.ts` are thin Obsidian shells, excluded from coverage.

## Build & tooling

- Protocol builds to `dist/` (tsc) and is consumed by the server build via the
  package symlink; tests resolve `@occ/protocol` to source via jest
  `moduleNameMapper`. The server uses a separate `tsconfig.test.json` (rootDir at
  the workspace, `jest` types) so cross-package test imports type-check.
- The plugin only **type-imports** `@occ/protocol`, so esbuild's bundle has no
  runtime dependency on it. Bundle: esbuild, `cjs`, `obsidian`/electron external.

## Deployment

- systemd unit `claude-anywhere-sdk.service` (`Restart=always`, `KillMode=process`,
  Tailscale-IP bind, no `ANTHROPIC_API_KEY`).
- **Plugin delivery via Obsidian Sync.** The host runs Obsidian Sync headless with
  **bidirectional** `community-plugin` config sync; writing the built plugin into
  the vault's `.obsidian/plugins/<id>/` propagates it (and a pre-seeded `data.json`
  with the server URL + token) to all devices. **Caveat:** bidirectional config
  sync will delete from the cloud any plugin missing from the host's local set, so
  the host's `.obsidian/plugins/` must stay a complete mirror. (Learned the hard
  way; do not switch to pull-only — that would break the deploy mechanism.)
- A tag-triggered GitHub Actions release workflow exists but **no release has been
  cut** — still a PoC.

## Open / deferred

- Server-restart resume depth: Level-1 (chosen) vs child-process-per-session.
- Exact "destructive" set — started conservative; revisit with real usage.
- Default model `claude-opus-4-8` (configurable).
- Port `8765` (freed from the decommissioned relay).
