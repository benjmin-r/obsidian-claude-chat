# Testing & feedback (PoC)

This is a proof of concept. Use this as a scripted walkthrough for a feedback
round, and check **Known limitations** before filing something — several rough
edges are already understood.

## Before you start

- Server `claude-anywhere-sdk.service` is `active` and listening on the tailnet.
- The `claude-chat` plugin is installed + enabled, with the server URL + token
  set in its settings.
- Open the chat from the ribbon (message icon) or command palette → *Open Claude chat*.

**Server-side telemetry:** the server logs connection lifecycle (no message text,
no token). To watch a session live:
`journalctl -u claude-anywhere-sdk -f` — you'll see `#N connected / <- hello /
<- user_message (id) / -> error: … / disconnected`.

## Walkthrough (tick as you go)

1. **Connect** — open the view; the badge should go `connected`.
2. **Basic turn** — send "hello"; assistant text should **stream** in with a cursor.
3. **Tool use** — "list the markdown notes in my vault"; expect a tool block +
   result, then a text answer, then `done` (status returns to `idle`).
4. **Thinking** — a reasoning-heavy prompt; expect an italic thinking block.
5. **Todos** — a multi-step request; expect the todo list above the transcript.
6. **Permission prompt** — ask it to delete or overwrite a file; expect an inline
   **Allow / Deny** box. Verify **Deny** blocks it and **Allow** lets it proceed.
7. **Markdown** — ask for a list/table/code block; check rendering.
8. **Interrupt** — start a long task, hit the stop icon; the turn should cancel.
9. **New session** — the *New* button starts a fresh transcript; *list* shows sessions.
10. **Resume (Level-2)** — mid-turn, background the app or drop network, then
    reopen; the transcript should replay and the turn continue.
11. **Mirroring** — connect from a second device to the same session; it should
    mirror read-only with a `(mirroring)` badge; only one writer at a time.
12. **CLI interop** — on the host, `claude --resume <id>` should see the session.

## Known limitations (don't file these)

- **Server restart loses the in-flight turn** (Level-1 resume) — by design.
- **No conversation persistence across closing the view.** Closing the sidebar
  disconnects; reopening does not auto-reattach to the previous session (the view
  doesn't yet remember the last session id). Use *list*/resume to get back.
- **Full re-render per event** — long transcripts may flicker or jump scroll;
  no incremental/virtualized DOM yet.
- **Session UI** — rename works; no delete/search yet.
- **Resume loads the full transcript.** Planned enhancement: load only the last
  N messages on resume, fetching older ones on demand via a "load older messages"
  affordance when the user scrolls up.
- **Text only** — no file/image attachments; no slash-command UI.
- **Permission prompt is per-request** — no "always allow this tool" memory.
- **Error surfacing is basic** — a Notice + an error line; not always actionable.
- Mobile layout/keyboard edge cases are largely untested.

## Filing feedback

Drop items here (or just tell me) using:

```
### <short title>
- Scenario:        (e.g. #6 permission prompt)
- Device:          (iOS / Android / desktop)
- Expected:
- Actual:
- Severity:        blocker / major / minor / polish
- Server log near the time (if any):
```

I'll correlate each with the server logs (`journalctl -u claude-anywhere-sdk`) and
triage into fixes.
