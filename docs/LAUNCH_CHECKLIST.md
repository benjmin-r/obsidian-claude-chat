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

Two real code fixes needed before store submission:

- `[MUST]` Hardcoded inline styles. `chat-view.ts` (lines ~162, 171, 360, 364, 618,
  629, 669) and `settings.ts` (82, 84) set `.style.display`, `.style.width`,
  `.style.borderColor` in JS. The guideline requires styling via CSS classes, not
  hardcoded in code. Replace the `display` toggles with a class (e.g. `.occ-hidden`),
  move the width to `styles.css`, and toggle an error class instead of setting
  `borderColor`.
- `[MUST]` Settings heading. `settings.ts:21` uses `containerEl.createEl("h2", ...)`.
  The guideline says use the heading API
  (`new Setting(containerEl).setName(...).setHeading()`), not an HTML heading — and
  with a single settings section you likely don't need a top heading at all.

## Phase 1 — Ship via BRAT (now)

- `[MUST]` End-to-end smoke test from a clean vault and clean server, following the
  README verbatim. The install steps are the product surface for a self-hosted plugin.
- `[MUST]` First-run / failure UX: server down, wrong token, Tailscale off, blank URL
  should each produce a clear message, not a dead sidebar.
- `[MUST]` Real mobile test (iOS + Android) over the tailnet, since the plugin ships
  `isDesktopOnly: false`.
- `[HIGH]` Screenshot or GIF in the README (streaming sidebar + a permission prompt).
  Highest-leverage adoption item.
- `[HIGH]` Replace `<owner>/obsidian-claude-chat` placeholders with the real GitHub
  path so the BRAT instructions are copy-pasteable.
- `[HIGH]` Cut the tag (`git tag 0.1.0 && git push origin 0.1.0`) and confirm the
  Release has all three assets and a BRAT install works.
- `[OPTIONAL]` `CHANGELOG.md` — skip for 0.1.

## Phase 2 — Community store submission

Required by the Developer Policies / Submission requirements:

- `[MUST]` Network-use disclosure in the README. Policy requires clearly stating
  network usage and which remote services are used. The architecture is documented,
  but add an explicit, labeled "Network use" statement: the plugin connects only to
  the user's self-hosted server over their tailnet; no third-party/cloud service; no
  telemetry.
- `[MUST]` Self-hosted-server / account requirement disclosure. Policy requires
  disclosing when full functionality needs an external account or service. State
  plainly that it requires a user-run server with an authenticated Claude subscription
  and Tailscale.
- `[MUST]` Apply the two code fixes above (inline styles, settings heading).
- `[MUST]` Confirm `manifest.description` is action-oriented, <=250 chars, ends with a
  period, no special characters. It qualifies; consider rephrasing to lead with the
  action.
- `[MUST]` Do not add a `fundingUrl` unless donations are actually accepted (policy
  says include it only then). Currently absent — fine.
- `[HIGH]` (Obsidian-optional, recommended) Add an "unofficial" disclaimer for the
  Claude/Anthropic name. Obsidian's policy only restricts confusing use of the
  *Obsidian* trademark (clear there), but stating "not affiliated with Anthropic"
  avoids implying endorsement.
- `[HIGH]` Fill `authorUrl` and make `author` the full name (matches the LICENSE).

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
