# Launch checklist

Plan: ship via BRAT now, submit to the official Obsidian community store later.

Priorities: `[MUST]` / `[HIGH]` / `[OPTIONAL]`. The compliance section was verified
against the current source; it states what is true today versus what still needs a fix.

## Compliance status (verified against the code)

Already satisfying Obsidian guidelines — no action:

- Command id `open-claude-chat` has no plugin-id prefix (Obsidian adds it automatically).
- No default hotkeys; no `window.app`/global `app`; `onunload` does not detach leaves.
- No Node/Electron APIs in the plugin, so `isDesktopOnly: false` is honest and the
  mobile-safe claim holds.
- No `innerHTML`/`outerHTML`, no sample placeholders (`MyPlugin`/`SampleSettingTab`),
  no telemetry, no self-updater, no ads, no obfuscation.
- `manifest.name` ("Claude Chat") contains neither "Obsidian" nor "Plugin";
  `id` ("claude-chat") doesn't contain "obsidian". Description is 100 chars (<=250)
  and ends with a period.
- LICENSE present with clear MIT designation.

Two real code fixes needed before store submission — both **DONE**:

- `[MUST]` ✅ Hardcoded inline styles. All static `.style.display` / `.style.width` /
  `.style.borderColor` assignments in `chat-view.ts`, `file-suggest.ts`, and
  `settings.ts` now toggle CSS classes (`.occ-hidden`, `.occ-input-invalid`,
  `.occ-modal-input` in `styles.css`). The only remaining `.style.` writes are the
  runtime-computed keyboard-inset values in `setKeyboardInset()` (element height +
  two CSS custom properties derived from the live keyboard height) — these are
  layout values that cannot be a static class and must stay in JS.
- `[MUST]` ✅ Settings heading. The `createEl("h2", …)` in `settings.ts` was removed
  (Obsidian renders the plugin name as the tab title; a single-section tab needs no
  extra heading). The remaining `createEl("h3"/…)` calls are inside Modals, not the
  SettingTab, so the heading guideline doesn't apply to them.

## Phase 1 — Ship via BRAT (now)

Remaining Phase-1 items need a real device/vault or a maintainer action — they can't
be done from a headless CI checkout:

- `[MUST]` ⏳ End-to-end smoke test from a clean vault and clean server, following the
  README verbatim. The install steps are the product surface for a self-hosted plugin.
- `[MUST]` ⏳ First-run / failure UX: server down, wrong token, Tailscale off, blank URL
  should each produce a clear message, not a dead sidebar. (Blank/malformed URL is now
  guarded in code — `BridgeClient.connect()` emits a clear error instead of throwing,
  with tests; the rest still needs a manual pass on a real device.)
- `[MUST]` ⏳ Real mobile test (iOS + Android) over the tailnet, since the plugin ships
  `isDesktopOnly: false`. (iPad on-screen keyboard and Android keyboard are still
  unverified with the final keyboard fix — see the handoff notes.)
- `[HIGH]` ⏳ Screenshot or GIF in the README (streaming sidebar + a permission prompt).
  Highest-leverage adoption item. (Needs a running instance to capture.)
- `[HIGH]` ✅ Replace `<owner>/obsidian-claude-chat` placeholders with the real GitHub
  path (`benjmin-r/obsidian-claude-chat`) so the BRAT instructions are copy-pasteable.
- `[HIGH]` ⏳ Cut the tag (`git tag 0.1.0 && git push origin 0.1.0`) and confirm the
  Release has all three assets and a BRAT install works. (Maintainer action — pushing a
  tag triggers the release workflow; not done autonomously.)
- `[OPTIONAL]` `CHANGELOG.md` — skip for 0.1.

## Phase 2 — Community store submission

Required by the Developer Policies / Submission requirements:

- `[MUST]` ✅ Network-use disclosure in the README. Added a labeled "Network use &
  requirements" section: the plugin connects only to the user's self-hosted server
  over their tailnet; no third-party/cloud service; no telemetry.
- `[MUST]` ✅ Self-hosted-server / account requirement disclosure. Same README section
  states plainly that full functionality requires a user-run server with an
  authenticated Claude subscription and Tailscale.
- `[MUST]` ✅ Apply the two code fixes above (inline styles, settings heading).
- `[MUST]` ✅ Confirm `manifest.description` is action-oriented, <=250 chars, ends with
  a period, no special characters. Rephrased to lead with the action ("Chat with
  Claude in a structured sidebar, …").
- `[MUST]` ✅ Do not add a `fundingUrl` unless donations are actually accepted. Still
  absent — fine.
- `[HIGH]` ✅ (Obsidian-optional, recommended) Added an "Unofficial" disclaimer in the
  README ("not affiliated with, endorsed by, or sponsored by Anthropic").
- `[HIGH]` ✅ Filled `authorUrl` (`https://github.com/benjmin-r`) and set `author` to
  the full name "Benjamin Reitzammer" (matches the LICENSE).

Submission process (from the docs):

1. `[MUST]` Repo public with `README.md`, `LICENSE`, `manifest.json`. Note: these live
   under `packages/plugin/` — the release assets are what matter, but verify the
   submission bot is happy with the monorepo layout (some checks look for a root
   manifest).
2. `[MUST]` GitHub Release tag must equal the manifest version, with `main.js` +
   `manifest.json` + `styles.css` attached. `release.yml` already enforces and does this.
3. `[MUST]` Sign in at community.obsidian.md, link the GitHub account, Plugins → New
   plugin, enter the repo URL, agree to the developer policies, Submit.
4. `[MUST]` Pass the automated validation bot; address feedback by updating the repo
   and publishing a new release with an incremented version.
5. `[OPTIONAL]` After acceptance, announce in the forum's Share & Showcase and the
   Discord `#updates` channel.

## Open flag

`manifest.json` is under `packages/plugin/`, not the repo root. BRAT pulls from release
assets so it's fine now, but confirm the Obsidian submission bot accepts a monorepo
layout before submitting to the store.
