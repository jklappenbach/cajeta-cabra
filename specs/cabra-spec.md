# cabra — resident-model serving harness

STATUS: DRAFT — four decisions open (§3.1, §5.1, §6.1, §7.1), each with a
recommendation. Nothing below is code yet; the plan follows approval.

## 1. Definition

cabra is a standalone application that keeps one LLM resident in memory
and serves prompts against it. It exists because the load is the
expensive part — Qwen2.5-VL-72B takes ~35 s to load and 15 ms/token to
prefill — so the model should be loaded once and *asked* many times.
cabra is the standard way to interact with a model in this ecosystem:
interactively during development, programmatically from scripts and CI,
and (later) as the installed application olla delivers.

**Boundaries.** The reference ecosystem maps as
`llama.cpp : llama-server : ollama` ≈ `dev.cajeta.llm : cabra : olla` —
with the correction that ollama's two halves split here: distribution
and install are olla's mandate; residency and serving are cabra's.
cabra is a SEPARATE project from cajeta-llm (decided 2026-08-26) and
consumes ONLY the engine's public API (`LlmEngine`, `submitTokens`/
`submitText`, `runAll`/`stepOnce`, `Request`, `SampleParams`,
`TokenSink`, `eogTokens`/`isEog`, `Tokenizer`, `ChatTemplate`). This
makes cabra the engine's first real embedder: anything cabra cannot do
through that API is an engine API gap, and it is discovered here first.

**Non-goals (v1).** Model download and install (olla's), multi-model
serving, remote/authenticated access (localhost only; no TLS), the
vision tower, sampling research. Each may become a later spec section.

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

- **3.1 DECISION — wire protocol.** RECOMMENDED: HTTP/1.1 + JSON on
  localhost, endpoints shaped OpenAI-compatible:
  `POST /v1/chat/completions` (messages array, rendered through the
  model's own chat template), `POST /v1/completions` (raw prompt),
  `GET /health` (model name, ready, resident memory). Streaming via
  SSE chunks (`stream: true`), matching the shape every existing client
  library already speaks. ALTERNATIVE (possible first unit): JSONL over
  stdin/stdout — one request object per line in, response/chunk objects
  out — trivial to implement and pipe-friendly, but reaches only local
  parent processes. NOTE: the stdlib has a full TCP stack
  (`cajeta.io.net.Server`/`ServerBuilder`, reactor, `Headers`, URI) but
  NO HTTP protocol layer — the HTTP option includes writing a minimal
  HTTP/1.1 request/response handler on `TcpStream` (bounded scope:
  content-length bodies, chunked responses for SSE, no keep-alive
  cleverness in v1).
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

## 5. Sessions and concurrency

- **5.1 DECISION — concurrency model.** RECOMMENDED: N concurrent
  in-flight requests, mapped onto the engine scheduler's continuous
  batching (`--max-seqs`, engine Units 8–11 — built for exactly this
  and never yet driven by a real multi-client caller). Conversation
  STATE stays client-side, as the OpenAI shape implies: each request
  carries its full messages array. ALTERNATIVE: strictly serial v1
  (one request at a time, others queue) — simpler to reason about,
  and continuous batching arrives as a v2 line item.
- **5.2** A request beyond capacity queues rather than erroring; a
  configured queue depth bounds it, and beyond that the server sheds
  with an explicit "busy" response (`cajeta.io.net.ConnectionLimiter`
  exists for the socket side).

## 6. Prompt cache

- **6.1 DECISION — KV reuse across turns.** RECOMMENDED for v1:
  re-prefill each request (correct, simple — and prefill is now 15.4
  ms/token batched, so a 2k-token conversation re-prefills in ~30 s on
  the 72B... which is exactly why this decision matters at v1.5).
  ALTERNATIVE: wire the engine's prefix block store (`--kv-store`,
  spec'd and built engine-side) so a conversation's shared prefix skips
  prefill; requires per-session affinity in the scheduler mapping.
  Recommendation is honest v1 scope, with 6.1-alt as the FIRST v2 item.

## 7. Lifecycle

- **7.1 DECISION — residency policy.** RECOMMENDED v1: resident until
  killed — `cabra serve --model <path>` loads, warms, listens, and only
  a signal ends it. ALTERNATIVE (ollama-style): idle unload after a
  keep-alive window and lazy reload on the next request — real memory
  courtesy on a 78 GB-resident 72B box, but reload is 35 s and the
  policy belongs with olla-installed daemon UX, not the dev harness.
- **7.2** Startup performs the engine's load-time warmup (already
  engine behavior) so the first request pays no first-touch cliff.
- **7.3** `GET /health` (or the JSONL `{"op":"health"}`) answers before
  and during load with a state field, so drivers can poll readiness.

## 8. Observability

- **8.1** Per-request: prompt tokens, generated tokens, prefill ms,
  decode ms, ms/token — in the response's usage block, so an eval
  driver needs no other instrumentation.
- **8.2** The route announcements the engine prints (batch-route,
  prefill mode) go to stderr/log, never into protocol responses.

## 9. Acceptance shape (informal, for the plan)

- Load the 72B once; three sequential prompts each answer correctly
  with `finish: eos` and no reload between them.
- A `-n`-capped request reports `budget`; a stop-string request
  reports `stop`.
- Two concurrent clients (if 5.1 = batching) both complete with
  correct, non-interleaved responses.
- Kill and restart: health reports loading, then ready.
