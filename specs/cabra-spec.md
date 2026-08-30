# cabra — resident-model serving harness

STATUS: ACTIVE — all four decisions made by Julian, 2026-08-27:
§3.1 JSONL-stdio first (HTTP later), §5.1 continuous batching,
§6.1 re-prefill v1, §7.1 resident until killed. Plan:
`agents/cabra-plan.md`.

## 1. Definition

cabra is a standalone application that keeps one LLM resident in memory
and serves prompts against it. It exists because the load is the
expensive part — Qwen2.5-VL-72B takes ~35 s to load and 15 ms/token to
prefill — so the model should be loaded once and *asked* many times.
cabra is the standard way to interact with a model in this ecosystem:
interactively during development, programmatically from scripts and CI,
and (later) as the installed application olla delivers.

**Boundaries.** REVISED 2026-08-27 (Julian's call, superseding the
"residency and serving are cabra's" reading below). The split is no
longer by layer but by KIND, and the test is: *what can only be done
where the weights are?*

- **`dev.cajeta.llm` owns the model as a living thing** — residency of
  weights, session/KV lifetime and prefix reuse across turns, adapters,
  in-place fine-tuning and training, checkpoints and deltas, and which
  specialized model is live. None of that is expressible without the
  forward graph and the tensors, so none of it can live in a harness
  without reimplementing the engine.
- **cabra owns the model's hands** — the execution context. Wire
  protocol, framing, ids, backpressure, stream multiplexing; and the
  agent surface: tools, plugins, MCP, sandboxing, permissions, audit.
  Those need *the world*, not the weights.

Note what did NOT move: residency-as-STATE is the engine's, but
SERVING stays cabra's. Folding the protocol into the engine is the
`llama.cpp → llama-server` path, and an engine with I/O in it stops
being testable — every defect found 2026-08-27 (a dangling sink, an
over-long prompt killing the process, a cross-talking demux) was a
*serving* defect, caught precisely because serving was isolated and
drivable from a test.

**The dependency arrow is one-way and must stay so.** The model needs
to CALL tools ("look up the truth when doubted"), and cabra owns tools
— done naively that points the arrow both ways. Instead the ENGINE
DECLARES THE INTERFACE and cabra implements it, exactly the shape of
`dev.cajeta.llm.DiagSink`: the engine declares a tool-call intent seam,
cabra implements it over MCP/plugins with sandboxing and audit. cabra
depends on cajeta-llm; cajeta-llm depends on nothing. That also keeps
the engine testable against a stub broker, which is the only way "the
model doubted itself and looked something up" is ever deterministic.

The reference ecosystem still maps as
`llama.cpp : llama-server : ollama` ≈ `dev.cajeta.llm : cabra : olla`,
with distribution and install olla's mandate.
cabra is a SEPARATE project from cajeta-llm (decided 2026-08-26) and
consumes ONLY the engine's public API (`LlmEngine`, `submitTokens`/
`submitText`, `runAll`/`stepOnce`, `Request`, `SampleParams`,
`TokenSink`, `eogTokens`/`isEog`, `Tokenizer`, `ChatTemplate`). This
makes cabra the engine's first real embedder: anything cabra cannot do
through that API is an engine API gap, and it is discovered here first.

**Non-goals (v1).** Model download and install (olla's), multi-model
serving, remote/authenticated access (localhost only; no TLS), the
vision tower, sampling research. Each may become a later spec section.
On-the-fly learning (directed 2026-08-26) is a spec of its own spanning
cabra and the engine — cabra's protocol and lifecycle sections here are
written knowing learning endpoints and adapter/memory state will land
on top of them.

## 2. Use cases

- **2.1 Interactive development.** Julian starts cabra with the 72B,
  then sends prompts for an hour without ever paying the load again.
- **2.2 Scripted evaluation / CI.** A test driver sends N prompts at
  temp 0 and asserts on the responses; exit codes and machine-readable
  finish reasons make it harness-able. This is the "our harness" role.
- **2.3 Benchmarking.** Timing lives outside the model process; cabra
  reports per-request token counts and phase timings so a driver can
  compute rates without instrumenting the engine.
- **2.4 Chat clients.** Anything that speaks the protocol (curl, a
  Python script, an editor plugin) can hold a conversation.
- **2.5 The installed app.** When olla grows application install
  (queued, spec-first), cabra is the first package: a website link
  installs cabra, and cabra serves.

## 3. Protocol

- **3.1 DECIDED (Julian, 2026-08-27): JSONL over stdin/stdout.** One
  JSON object per line in; response and chunk objects, id-tagged, per
  line out. stdout is PROTOCOL-PURE — logs and the engine's route
  announcements go to stderr only. HTTP comes later as a transport in
  front of the same operation set (the stdlib has TCP but no HTTP
  layer; that scope waits). The op set is transport-neutral by
  construction so the HTTP unit adds a listener, not a rewrite.
- **3.1.1 Requests** (stdin, one object per line; `id` is the caller's
  correlation key, echoed on every output line for that request):
  - `{"op":"generate","id":1,"prompt":"...", ...}` — raw completion,
    no template.
  - `{"op":"chat","id":2,"messages":[{"role":"user","content":"..."}],
    ...}` — rendered through the model's own chat template.
  - `{"op":"health","id":3}` — state before/during/after load.
  - `{"op":"shutdown"}` — drain and exit 0. EOF on stdin means the
    same.
- **3.1.2 Responses** (stdout, one object per line):
  - stream chunks: `{"id":1,"chunk":"text"}` — one per decoded span,
    EOG tokens never present (§4.2).
  - completion: `{"id":1,"done":true,"finish":"eos","usage":
    {"prompt_tokens":N,"gen_tokens":M,"prefill_ms":X,"decode_ms":Y}}`.
  - health: `{"id":3,"state":"loading"|"ready","model":"<path>"}`.
  - errors: `{"id":1,"error":"<message>"}` — a malformed line answers
    with `"id":null` and never kills the server.
- **3.2** Requests carry sampling parameters (temperature, top-k, top-p,
  repeat penalty, seed, max tokens, stop strings); absent fields take
  the model-appropriate defaults. A `temp: 0` request is deterministic.
- **3.3** Every response reports a finish reason — `eos`, `budget`
  (max tokens), or `stop` (caller's stop string) — mapped from the
  engine's `Request.finishReason`.

## 4. End of response

- **4.1** A response terminates when the engine's end-of-generation set
  fires — `LlmEngine.eogTokens`: the GGUF's eos/eot/eom metadata ids
  unioned with the vocab scan (`Tokenizer.eogIds`). This is engine
  behavior as of 2e7c1c7 (the 72B's two-ender bug); cabra RELIES on it
  and never re-implements it.
- **4.2** EOG tokens never appear in response text or stream chunks.
- **4.3** Caller-supplied stop strings are honored in addition to the
  EOG set, and reported as `stop`, not `eos`.
- **4.4** A response also terminates on ERROR, and `error` is a
  terminating reason alongside `eos`, `stop` and `budget`. Failing after
  tokens have already streamed is a distinct case from failing before
  generation starts, and a client that has rendered half an answer needs
  to be told which happened.

### 4.5 Error kinds

The engine is consumed IN-PROCESS, so its exceptions need no wire
representation — `LlmException` with a message is right for that boundary
and does not change. cabra's protocol is the boundary a program acts
across, so its errors carry a KIND, not just text.

- **4.5.1** When cabra reports an error, it names a kind a client can act
  on. A message alone can only be displayed.
- **4.5.2** The kinds distinguish the responses a client can actually
  make: bad request (fix and resend), capacity (back off and retry),
  session gone (open a new session, resend context), model mismatch
  (fatal for this host), internal (report, do not retry).
- **4.5.3** cabra classifies from structure, never by matching engine
  exception text. Capacity is already structural — `appendRow` returns
  false when no block is free, which §6.4 of the engine spec calls the
  scheduler's signal — and cabra validates its own inputs before
  submitting. What remains is genuinely internal, which is the correct
  thing to tell a client anyway.
- **4.5.4** An error that ends a session says so; an error the session
  survives leaves it usable for the next turn.

## 5. Modes, sessions and concurrency

**REVISED 2026-08-30 (Julian).** §5.1 previously had cabra multiplexing N
requests over one stdio pipe by `id`, reached in two staged steps. That
is extended rather than discarded, and the precise limit matters:

- stdio is a channel between a process and its PARENT. One parent can
  drive N id-tagged conversations over it against one in-process model —
  the original §5.1 design, and it works.
- stdio cannot accept a second CONNECTION. A separate client process
  cannot join; it can only spawn its own cabra, which costs another
  model load — 4.9 GB for the 8B, 48 GB for the 72B.

So sharing one loaded model **across independent client processes**
requires a listening socket. That is what host mode adds, and it is the
only thing stdio could not have done.

### 5.1 Three modes

- **5.1.1 Embedded.** The model and engine live in cabra's process. One
  conversation, one model load, no listener. This is what cabra does
  today.
- **5.1.2 Host.** cabra loads the model and serves WebSocket clients,
  each connection carrying one conversation, multiplexed onto the
  engine's continuous batching.
- **5.1.3 Client.** cabra connects to a host and drives one conversation.
- **5.1.4 When a host is running, several client PROCESSES share its one
  loaded model.** Weights are shared in exactly two arrangements: several
  conversations driven by one parent over stdio, and several client
  processes against a host. Anything else costs a load per process.

**The engine has no wire protocol at all.** `dev.cajeta.llm` is a library
with a function-call API — no listener, no message format, no session
registry. cabra provides EVERY expression of the contract: stdio for a
parent process, WebSocket for remote clients, the same op set and the
same session ids over both. Serving is cabra's job, which is what its
name has always said, and it keeps the engine embeddable by third parties
without an HTTP stack in their build graph (§5.6).

### 5.2 Sessions

A **session** is one conversation's state in the engine: its KV slot, its
sampling parameters, its in-flight turn. **The session id is part of the
protocol contract** (Julian, 2026-08-30), on every transport.

- **5.2.1** When a client opens a session, it receives a session id, and
  every subsequent message names the session it belongs to.
- **5.2.2** A session is NOT bound to a connection. When a client
  reconnects, it resumes by naming its session id, and the host-side
  prefix cache is still warm.
- **5.2.3** When a client closes a session explicitly, its KV slot returns
  to the pool.
- **5.2.4** When a session has been idle beyond a configured period, the
  host expires it and reclaims the slot. Expiry is the only reclamation
  path for a client that vanished without closing.
- **5.2.5** When a client names a session that has expired or never
  existed, it is told so explicitly rather than being given a silently
  fresh one — the difference matters, because a fresh session means the
  conversation's context is gone from the cache.
- **5.2.6** One connection MAY carry several sessions. Nothing requires it,
  and cabra in client mode drives one, but the contract does not forbid a
  client that holds several conversations.
- **5.2.7** Sessions are independent: one session's parameters,
  cancellation or failure never perturb another's output.
- **5.2.8** Conversation STATE stays client-side: each request carries its
  full context, so host-side KV is a cache and never a record. A client
  that reconnects after a crash resumes by resubmitting; a host that
  evicts blocks costs latency, never a different answer.

*Why the id rather than the connection.* Binding a session to its
connection is simpler — no registry, no expiry, no orphans — but it makes
a dropped connection cost a full re-prefill, and it would leave the two
transports carrying different op sets, since §3's stdio protocol is
already id-tagged. The id keeps one protocol across both and makes the
prefix cache survive a reconnect, which is the whole point of having one.

### 5.3 Concurrency

- **5.3.1** A request beyond capacity queues rather than erroring; a
  configured queue depth bounds it, and beyond that the host sheds with
  an explicit "busy" response (`cajeta.io.net.ConnectionLimiter` exists
  for the socket side).
- **5.3.2** When a client stops reading, other sessions are not blocked
  waiting for it.

### 5.4 Transport

- **5.4.1** Host mode speaks WebSocket, over `dev.cajeta.http`, which
  already implements the handshake, framing, close codes and
  permessage-deflate.
- **5.4.2** Embedded mode speaks the §3 stdio protocol. Both carry the
  same op set.
- **5.4.3** The serving core is transport-neutral: a transport supplies a
  message channel — read a message, write a message, close — and the core
  never branches on which it is running over. An in-memory channel
  implements the same seam, so the op set and session lifecycle are
  testable without sockets, pipes or a model.

### 5.5 Authentication

- **5.5.1** When a client connects to a host, it presents a token before
  any other op is accepted.
- **5.5.2** The host learns only that the connector holds a valid token,
  not WHICH client connected. Per-client identity needs peer credentials,
  and cajeta's stdlib has no `AF_UNIX` — loopback TCP cannot supply them.
- **5.5.3** The token is modelled as a credential rather than as a shared
  secret, so it can later carry a client identity that policy keys on
  (§5.7) without a protocol change.
- **5.5.4** Embedded mode requires no token: the caller owns the process.

### 5.6 Packaging

- **5.6.1** `dev.cajeta.llm` takes no HTTP dependency. It is the artifact
  third parties embed, and an inference library that drags HTTP/2 and
  HPACK into a build is materially harder to adopt.
- **5.6.2** cabra takes `dev.cajeta.http`. cabra is an application, not a
  library, so the dependency stops with it.
- **5.6.3** `dev.cajeta.llm` takes `dev.cajeta.logging`, and that is not
  the same kind of dependency as §5.6.1's. Logging is cross-cutting
  infrastructure — the fleet's standard, 158 KB, nothing behind it, and
  wanted by essentially every application. An HTTP stack is a SERVING
  capability: large, unrelated to inference, and something an embedder
  actively does not want in a build. The engine keeps `Diag` as a hook
  regardless, so the library still chooses no backend and stays silent
  until an application installs a sink.
- **5.6.4** Diagnostics go to the log, never to stderr, and never onto a
  protocol stream. stderr is a severity channel — route notes arriving
  painted red read as faults — and stdout carries protocol. Host mode
  strengthens this: a host's own logs and the engine's route diagnostics
  belong in ONE aggregated stream (`Log.at`), not two.

### 5.7 Guardrails — DEFERRED (Julian, 2026-08-30)

Per-client constraints, permissions, and policy over what a model may make
the machine do are **out of scope for now**, to be implemented as model
capabilities become clear rather than designed against a guess.

Consequences worth stating, since they were load-bearing in the
discussion that produced this section:

- **5.7.1** Without guardrails, the per-client process boundary is no
  longer a security boundary. What remains is crash isolation, and the
  fact that any process speaking the protocol can connect.
- **5.7.2** Where guardrails eventually live — in the host per session, or
  in each client process — is therefore OPEN. Nothing in §5 forecloses
  either; §5.5.3 keeps the credential able to carry identity, and the
  session id (§5.2.1) gives policy something durable to attach to.

## 6. Prompt cache

- **6.1 DECIDED (Julian): re-prefill v1.** For the record:
  re-prefill each request (correct, simple — and prefill is now 15.4
  ms/token batched, so a 2k-token conversation re-prefills in ~30 s on
  the 72B... which is exactly why this decision matters at v1.5).
  ALTERNATIVE: wire the engine's prefix block store (`--kv-store`,
  spec'd and built engine-side) so a conversation's shared prefix skips
  prefill; requires per-session affinity in the scheduler mapping.
  Recommendation is honest v1 scope, with 6.1-alt as the FIRST v2 item.
- **6.2 OWNERSHIP (2026-08-27).** Under the §1 boundary revision,
  6.1-alt is ENGINE work, not cabra work: sessions, KV lifetime, and
  prefix reuse across turns are the model's living state. cabra's part
  shrinks to naming the session on the wire (a `session` field on the
  request) and honouring whatever affinity the engine asks for. Track
  6.1-alt in the engine's plan; leave only the protocol field here.

## 7. Lifecycle

- **7.1 DECIDED (Julian): resident until killed.** v1: resident until
  killed — `cabra serve --model <path>` loads, warms, listens, and only
  a signal ends it. ALTERNATIVE (ollama-style): idle unload after a
  keep-alive window and lazy reload on the next request — real memory
  courtesy on a 78 GB-resident 72B box, but reload is 35 s and the
  policy belongs with olla-installed daemon UX, not the dev harness.
- **7.2** Startup performs the engine's load-time warmup (already
  engine behavior) so the first request pays no first-touch cliff.
- **7.3** `{"op":"health"}` answers before
  and during load with a state field, so drivers can poll readiness.

## 8. Observability

- **8.1** cabra logs. It is an application, and `dev.cajeta.logging` is
  the ecosystem's telemetry lingua franca (Julian, 2026-08-30).
- **8.2** When the engine records a diagnostic, cabra PULLS it rather than
  receiving a pushed line (`cajeta-llm-spec` §11.8). cabra then decides
  what to do with it: log it, drop it, or forward a session's records to
  the client that owns that session.
- **8.3** Engine route diagnostics stay DEBUG. They are tuning detail for
  whoever is measuring the engine, not news for whoever is operating the
  host, and at INFO they would recreate the console noise the hook exists
  to prevent.
- **8.4** cabra's own logs and the engine's records aggregate into ONE
  stream (`Log.at`, which borrows the process's DI encoder and appender),
  not two that happen to both reach the console.
- **8.5** Diagnostics never travel on a protocol stream, and never on
  stderr. stdout carries protocol; stderr is a severity channel, so route
  notes arriving there read as faults.
- **8.6** When a session is created, resumed, expired or evicted, that is
  visible in the log without enabling per-token detail.

## 9. Acceptance shape (informal, for the plan)

- Load the 72B once; three sequential prompts each answer correctly
  with `finish: eos` and no reload between them.
- A `-n`-capped request reports `budget`; a stop-string request
  reports `stop`.
- Two concurrent clients (if 5.1 = batching) both complete with
  correct, non-interleaved responses.
- Kill and restart: health reports loading, then ready.
