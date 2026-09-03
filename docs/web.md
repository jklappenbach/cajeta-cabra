# The cabra web client

A browser client for a running cabra host (spec §10). It is a §5.1
CLIENT — the conversation lives in the browser, the host is a cache —
speaking the §3 op set over WebSocket, plus the `cancel` op (§10.5).

## Running it

Build once, then let the host serve it on its own port:

```
cd web && npm ci && npm run build         # -> web/dist
cabra host --model <gguf> --token <T> --web web/dist [--port 8850] [--device hip]
```

Open `http://127.0.0.1:<port>/`. The host serves `web/dist` on plain
GETs and the WebSocket on `/ws`, one port, one process (§10.1). Without
`--web` the host is ws-only, as before. Loopback only (§5.5.2): run the
browser on the box, or bring your own tunnel.

For development, `npm run dev` serves the page with hot reload and
proxies `/ws` to a host already running on 127.0.0.1:8850.

## What it does

- **Token first** (§10.3): the host token is asked for before anything
  else, kept for the browser session, presented as `auth`. A rejected
  token says so; "no host at this address" is a different message.
- **Conversations** (§10.2, §10.7): several, each its own session on one
  socket, all held in `localStorage` — a reload loses nothing. Switching
  never cancels another's turn.
- **Streaming** (§10.4): chunks render as they arrive; the finished
  answer renders as sanitized markdown; the finish reason and usage show
  when the turn ends.
- **Stop** (§10.5): a turn in flight can be cancelled; it ends with
  `finish: "cancel"`.
- **Reconnect and resume** (§10.6): a dropped socket redials and
  continues on the same session id; a host restart (which reloads the
  model) is waited through. When the host reports the session gone, the
  client opens a new one and resubmits the conversation, with a notice.
- **Diagnostics** (§10.9): per conversation, opt in under Sampling; the
  host then forwards that turn's route / prefill-mode / expert-cache
  records to the panel. Off by default; nothing is formatted when off.

## Tests

`npm test` runs the protocol client's tests (vitest) — a state machine
over a scripted socket, no DOM, no host: auth, sessions, streaming,
cancel, the §4.4 error split, reconnect, `session_gone` resubmit, and
diag routing. The engine- and host-side halves are cajeta tests
(`CancelTest`, `WebFrontTest`, `DiagForwardTest`).
