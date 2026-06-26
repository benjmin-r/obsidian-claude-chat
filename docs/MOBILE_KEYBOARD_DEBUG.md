# Mobile keyboard / layout debug panel — reference for LLMs

> Audience: an LLM debugging an on-screen-keyboard (OSK) or layout bug on a mobile
> device the maintainer cannot reach. A human reporter runs the plugin, taps a button,
> and pastes a text report; you read it. This file explains every field, the platform
> facts behind the layout code, and how to reason from the numbers to a fix.

## Status / intent

The panel lives in `packages/plugin/src/chat-view.ts` (the
`// --- on-screen-keyboard debug panel ---` block: `mountKbDebug` / `kbSnapshot` /
`kbReport`). It is **gated behind the `debugKeyboardPanel` setting** (default `false`), so
it ships off but a remote issue-reporter can enable it, reproduce, and paste the report.
Wiring: the flag is in `settings-types.ts` (`DEFAULT_SETTINGS`) with a toggle in
`settings.ts` ("Keyboard debug panel"); `ChatView.onOpen` guards `this.mountKbDebug()` with
`if (this.plugin.settings.debugKeyboardPanel)`. Keep this doc in sync if you change the
report format.

## How a report is produced

0. In **Settings → Claude Chat → Keyboard debug panel**, turn it on, then reopen the chat
   view (toggle the plugin or reopen the leaf — the panel mounts on view open).
1. Reporter opens the Claude Chat view.
2. A green **`Copy KB (n)`** button is fixed top-right (`top:56px right:6px`); `n` is the
   number of snapshots captured so far (it ticks up every 500ms, proving it's alive).
3. Reporter taps the message input to raise the keyboard, waits ~2s, then taps **Copy KB**
   (it sits above the keyboard so it stays tappable). A snapshot history is also kept, so
   dismissing the keyboard first and then copying still captures the keyboard-up frames.
4. The clipboard text is pasted back to you.

One `ChatView` mounts one button on `document.body`. If two chat views are open (e.g. a
main tab **and** the right sidebar), there are two overlapping buttons at the same fixed
spot; only the top one is tappable and it reports **its own** view. To measure a specific
leaf, close the other chat view first.

## Report format

```
=== OSK debug (+12.3s) ===
win inner 1366x1024 outer 1366x1024
screen 1024x1366 avail 1366x1024
docEl.client h=1024 vv.scale=1
safe-area top=24px bottom=34px | body.clientH=1024
KB events: keyboardWillShow(498)@+5.8s  keyboardDidShow(498)@+6.2s               <- raw native events

snapshots (oldest→newest):
[+6.2s] <<keyboardDidShow>> foc=F kbH=498 cc top=134 bot=644 h=510 styleH=392px usedH=510px minH=392px maxH=392px kbLayout=open | parent=workspace-leaf-content ph=434 leafBot=802 | comp top=573 bot=636 visBot=526 => BEHIND-KB
...
```

### Header fields

| Field | Source | Meaning / gotcha |
|---|---|---|
| `win inner WxH` | `window.innerWidth/Height` | Layout viewport. **On iOS it does NOT shrink when the keyboard opens** — stays full height. Do not use it as "visible height". |
| `win outer WxH` | `window.outerWidth/Height` | Usually equals inner in the app webview. |
| `screen WxH` | `screen.width/height` | Physical-ish screen. Reported in the device's **native orientation** (e.g. portrait values while the app is landscape) — don't be alarmed by the swap. |
| `avail WxH` | `screen.availWidth/Height` | Screen minus OS chrome. |
| `docEl.client h` | `documentElement.clientHeight` | Another full-height signal; also inert w.r.t. the keyboard on iOS. |
| `vv.scale` | `visualViewport.scale` | Pinch-zoom factor. `1` = no zoom. If not 1, all px are scaled and rects need care. |
| `safe-area top/bottom` | `env(safe-area-inset-*)` via a probe element | OS insets (status bar / home indicator). NOTE the home indicator (~34px) is **not** the same as Obsidian's mobile navbar (~52px), which floats over the main-area leaf and is **not** covered by this inset — that navbar is why the composer needed an extra bottom inset in the tab view (see `occ-phone-main` in the layout code). |
| `body.clientH` | `document.body.clientHeight` | Body height; cross-check against `win inner`. |

### `KB events:`

Each native `window` keyboard event captured, in order, as `name(keyboardHeight)@elapsed`:
`keyboardWillShow` / `keyboardDidShow` / `keyboardWillHide` / `keyboardDidHide`.

- **This is the ONLY reliable keyboard signal on iOS Obsidian.** `visualViewport`,
  `100dvh`/`100svh`, and `env(keyboard-inset-height)` are all inert (report full height
  with the keyboard up). The native bridge fires these `window` events carrying
  `e.keyboardHeight` in CSS px.
- `(none)` / empty → the device never fired keyboard events. Then `setKeyboardInset` never
  runs and the composer will sit behind the keyboard. That itself is the finding.
- Two-stage values are normal on iPad: a small height first (e.g. `66`, the shortcut/
  predictive bar) then the full height (e.g. `498`). The code uses the latest event.

### Snapshot line

Captured every 500ms and on every keyboard event (cap 30, ~15s rolling window).

| Token | Source | Meaning |
|---|---|---|
| `[+Xs]` | elapsed | Seconds since the first measurement. |
| `<<eventName>>` | tag | Present when this snapshot coincided with a keyboard event — the interesting frames. |
| `foc=F/-` | `document.activeElement === inputEl` | Whether the composer is focused. Useful because some iOS layout glitches only occur while the input is focused. |
| `kbH=N` | last event height | Last known keyboard height (0 when hidden). The basis for `visBot`. |
| `cc top/bot/h` | `contentEl.getBoundingClientRect()` | `contentEl` is `.view-content` (we add `.occ-chat`). Its viewport rect. |
| `styleH` | `contentEl.style.height` | The inline height we *requested* (`—` if unset). iPhone path sets it; iPad path does not. |
| `usedH` | `getComputedStyle(cc).height` | The height **actually applied**. **`usedH` ≠ `styleH` means the engine ignored our request** (the core iPad bug: `usedH=510px` while `maxH=392px`). |
| `minH` / `maxH` | computed | The min/max-height in force. If `usedH > maxH`, the box is escaping its own constraint (iPad WebKit). |
| `kbLayout=open/tablet/none` | which kb class is on `cc` | `open` = iPhone height-pin layout (`.occ-kb-open`); `tablet` = iPad top-anchored layout (`.occ-kb-tablet`); `none` = keyboard down / no override. |
| `parent=CLASS ph=N leafBot=N` | `cc.parentElement` class, rect height, rect bottom | The Obsidian leaf container (`workspace-leaf-content`). **Key signal:** on iPad `ph` **shrinks by ~`keyboardHeight`** when the keyboard opens (native leaf resize); on iPhone it does **not**. `leafBot` (viewport-y of the leaf bottom) helps spot bottom-chrome overlap (e.g. the navbar). |
| `comp top/bot` | `inputRowEl.getBoundingClientRect()` | The composer (input row) rect. `bot` is what must stay above the keyboard. |
| `visBot=N` | `innerHeight − kbH` | The **real keyboard top**, computed (because `visualViewport` is inert). This is the line the composer must stay above. |
| `=> visible / BEHIND-KB` | `comp.bottom > visBot+1` | Verdict. `BEHIND-KB` = composer is hidden behind the keyboard (the bug). |

### Adding one-off probes

The report intentionally carries only durable fields. During a hunt it's normal to add a
temporary probe to a snapshot/header (e.g. a specific element's rect, `cc.scrollTop`, an
`env()` value via a probe div, or a `document.querySelector` of Obsidian chrome) and strip
it afterwards. The resolved gotchas below were all found that way.

## Resolved gotchas (how they presented vs what they were)

These wasted real time; recognise them by symptom:

- **"Toolbar icons look squished/clipped" (iPad, keyboard up).** The icons' boxes were a
  correct `18x18` the whole time — it was the **toolbar itself collapsing** to ~9px tall
  (its `overflow:hidden` set the flex auto-min-size to 0, so it shrank under the keyboard
  relayout) and clipping the icons. Fix: `.occ-toolbar { flex: 0 0 auto }`. It was **not**
  horizontal squish and **not** an SVG raster bug (translateZ/repaint hacks did nothing).
  Lesson: if an element's rect looks right but it renders wrong, measure its **container**.
- **"Composer hidden at the bottom" (iPhone, keyboard down, main tab only).** Not a
  safe-area issue — the home-indicator inset (34px) was already clear. It was **Obsidian's
  mobile navbar** (`~52px`, `.mobile-navbar`) floating over the main-area leaf. Fix: a
  bottom inset applied **only** to a main-area leaf (`occ-phone-main`, set when
  `leaf.getRoot() === workspace.rootSplit`), not sidebars (which have their own toolbar).
- **All-zero snapshots / `foc=-` while `kbH>0`.** The measured view was a **backgrounded
  leaf** (`display:none` → every rect 0); the keyboard belonged to a different, foreground
  chat view. Close the other view (see two-views note).

## Platform model (why the layout code branches)

Decided from real device reports; see `setKeyboardInset` / `setKeyboardInsetTablet` and
`TECHNICAL_DECISIONS.md`.

- **Shared:** `window.innerHeight` stays full with the keyboard up on both; the only
  keyboard signal is the native events; real keyboard top = `innerHeight − keyboardHeight`.
- **iPhone (`Platform.isPhone`):** the Obsidian leaf stays full-height when the keyboard
  shows, so the app must carve out the space itself. `setKeyboardInset` pins
  `contentEl`'s height (`height` + `min-height` + `max-height` + `flex:none`) to the area
  above the keyboard and switches to the `.occ-kb-open` absolute layout (composer
  `bottom`-anchored). The height-pin **is** honored here.
- **iPad (`Platform.isTablet`):** the leaf is resized by iPadOS to sit above the keyboard
  (parent `ph` drops by exactly `keyboardHeight`), but `window.innerHeight` stays full
  **and** iPad WebKit refuses to shrink `contentEl` below its ~content-min (so
  `height`/`min`/`max` are not honored — `usedH` exceeds `maxH`). The iPhone strategy
  therefore fails two ways. `setKeyboardInsetTablet` instead anchors by **`top`** using the
  two stable values — `contentEl.top` and the computed keyboard top — placing the composer
  so its bottom lands ~16px above the keyboard, with the messages as a definite band above
  it (`.occ-kb-tablet`, `overflow:hidden` to clip the dead area behind the keyboard, 12px
  side insets).

## Diagnosing a new device from a report

1. **Do keyboard events fire, and with what height?** (`KB events:`). No events → no signal
   → expect the composer behind the keyboard; the fix is finding a signal, not layout math.
2. **Is our requested height honored?** Compare `styleH` vs `usedH`. Divergence → the
   engine is ignoring the height-pin (don't fight it; anchor by `top` instead).
3. **Does the leaf resize?** Watch `parent ... ph=` across `keyboardDidShow`. A drop by
   ~`keyboardHeight` → the platform makes room itself (lean on it / get out of the way).
4. **Is the composer behind the keyboard?** `comp bot` vs `visBot`, and the `=> ` verdict.
   Trust `visBot` (computed), not `visualViewport`.
5. **An element renders wrong but its rect looks right?** Measure its container — it may be
   collapsing/clipping (see the toolbar gotcha), not the element itself.
6. **Bottom chrome overlap?** Compare `comp bot` / `leafBot` against `win inner`; if the
   composer is within the viewport yet visually covered, suspect floating app chrome (the
   mobile navbar), not the OS safe-area.

## Deploying a debug build (maintainer, on the vserver)

```bash
cd ~/projects/obsidian-claude-chat
npm run build -w @occ/plugin
cp packages/plugin/main.js packages/plugin/styles.css packages/plugin/manifest.json \
   ~/vaults/benjamin/.obsidian/plugins/claude-chat/          # never copy data.json
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart obsidian-sync.service
```

Then reload the plugin on the device (syncing files does not hot-reload). CSS-only changes
still need a plugin reload to re-read `styles.css`.
