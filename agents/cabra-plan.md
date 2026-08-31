# cabra plan — resident-model serving harness, v1

Spec: `specs/cabra-spec.md` (all four decisions made 2026-08-27:
JSONL-stdio, continuous batching, re-prefill, resident-until-killed).

**Deliverable:** the `cabra` executable — `cabra serve --model <gguf>
[--ctx N] [--max-seqs N] [--device <backend>]` — which loads once,
answers id-tagged JSONL requests on stdin with id-tagged JSONL on
stdout, streams chunks as tokens decode, stops every response on the
engine's EOG set, and reports machine-readable finish reasons and
usage. stdout is protocol-pure; all logs on stderr.

**Systems used:** `dev.cajeta.llm` (LlmEngine, Scheduler continuous
batching, TokenSink, eogTokens, Tokenizer, ChatTemplate) via sibling
checkout in dev / olla pin in release; `dev.cajeta.codec` (JSON);
`dev.cajeta.unit` (tests). No networking in v1.

**Checkbox legend:** `- [ ]` open, `- [x]` done, `- [~]` blocked.

**BOUNDARY REVISION (Julian, 2026-08-27).** The engine/harness split is
now by KIND, not by layer — see `specs/cabra-spec.md` §1. The engine
owns the model as a living thing (residency of weights, session/KV and
prefix reuse, adapters, in-place training, checkpoints, model-set
routing); cabra owns the model's hands (protocol, framing, batching
demux, and the agent surface: tools, plugins, MCP, sandbox,
permissions, audit). Serving stays here; residency-as-state moves to
the engine. The dependency arrow stays one-way — the engine DECLARES
seams (the `DiagSink` shape) and cabra implements them.

Consequences for THIS plan: units 1-4 are unaffected (all serving).
Unit 5's docs must describe the revised boundary. The next plan after
this one is the tool/MCP surface, and the `ToolBroker`-shaped seam
should be defined before the learning child specs, since 3.1 and 3.4
both route through it.

---

## 1. Build + test scaffolding

### 1.1 TDD
- [x] 1.1.1 A trivial `@Test` in `dev.cajeta.cabra.selftest` runs green
      through `./run-tests.sh` (proves the harness resolves cajeta-unit
      and the sibling engine .cja with codec/jinja transitively).

### 1.2 Coding
- [x] 1.2.1 `run-tests.sh` modeled on cajeta-llm's: resolve
      dev.cajeta.llm from the sibling checkout (build its .cja if
      stale), codec/jinja/unit as cajeta-llm's script already does.
- [x] 1.2.2 `scripts/bld.sh <backend> <out>` (DEVIATION from the
      original `tmp/bld.sh` wording: tmp/ is gitignored and this is
      project infrastructure, so it is versioned) building the
      executable from
      `dev.cajeta.cabra.Main.main` with the engine on the classpath —
      the same gate discipline (exit code AND binary AND
      CAJETA_ERROR grep; watch `kernels skipped`).

### 1.3 Acceptance
<!-- 2026-08-27: suite 4/0/1 with the engine resolved from the sibling
     checkout; vulkan exe builds and prints usage. Note: the stub Main
     pulls no engine code, so `kernels skipped: 0` — expect 7 once the
     serve loop binds LlmEngine (unit 2), and CHECK it then. -->
- [x] 1.3.1 Both scripts run clean from a fresh checkout beside
      cajeta-llm.

## 2. Protocol core — parse, dispatch, answer (serial)

### 2.1 TDD
- [x] 2.1.1 Line parser: a well-formed `generate` request parses to op,
      id, prompt, sampling fields; absent fields take defaults; a
      malformed line yields an error object with `"id":null` and the
      loop CONTINUES (the negative half: the server must not die).
- [x] 2.1.2 Response encoder: chunk, done (finish + usage), health, and
      error objects each serialize to one line of valid JSON — asserted
      by parsing them back with the codec, not by string comparison.
- [x] 2.1.3 End-to-end over the TOY model (cajeta-llm's
      `src/test/fixtures/gguf/toy.gguf` via the sibling path): a
      `generate` with `"n":4` yields ≥1 chunk line, then a done line
      with `finish:"budget"` and a usage block whose token counts match
      the chunk stream.

### 2.2 Coding
- [x] 2.2.1 `Main.main` — arg parse (`serve --model --ctx --max-seqs
      --device`), engine load, serve loop.
- [x] 2.2.2 `Protocol` — request parse (codec JSON) + response emit;
      stdout write is line-atomic; flush per line.
- [x] 2.2.3 `Serve` — the serial loop: read line, dispatch op, drive
      the engine (`submitTokens`/`submitText` + `runAll`), stream via a
      `TokenSink` that emits chunk lines (EOG ids filtered through
      `engine.isEog` — spec 4.2), answer done with finish + usage.
- [x] 2.2.4 stderr discipline: every diagnostic through a logger that
      writes fd 2; nothing but protocol objects on fd 1 (the engine's
      own route prints already go to stdout — REDIRECT or accept them
      on stderr via engine option; resolve which and record it here).

#### Unit 2 notes (2026-08-27)
- 2.2.4 resolved by fixing the ENGINE: batch-route / kernel-avail /
  prefill announcements moved to stderr (llm main, "serve-path
  diagnostics to stderr").
- The protocol round-trip test found a STDLIB defect: JsonWriter passed
  control characters through raw — invalid JSON that splits JSONL
  framing. Fixed in the compiler repo (bc825d85) with its own
  round-trip test; the first piped run promptly streamed a `\u0004`
  chunk through the fix.
- COMPILER GAP — diagnosed and FIXED 2026-08-27 (cajeta c963d19b), and
  the original description here was wrong. It is not a resolution bug:
  the compile verb reads exactly THREE positionals (entry, source root,
  output dir) and only guarded the low side, so a fourth argument
  SHIFTED the rest and bound the second source tree to the output
  directory — exit 0, empty output dir, object files written into a
  source tree, none of that tree's types compiled. Multi-tree builds
  were always a --classpath workflow (the engine repo's own pattern,
  which both scripts here follow). Now a hard error naming --classpath.
- Suite 10/0/1; pipe acceptance: 6/6 stdout lines machine-parse, logs
  on stderr, exit 0.

### 2.3 Acceptance
- [x] 2.3.1 `printf '...generate...' | cabra serve --model toy.gguf`
      emits exactly parseable JSONL on stdout and exits 0 on EOF.

## 3. Chat op, finish reasons, health, shutdown

### 3.1 TDD
- [x] 3.1.1 `chat` renders through the model's template: over a
      template-bearing fixture, the rendered ids equal
      tokenizer.encode(template.render(messages)) — the same
      no-double-BOS discipline chatMain already pins.
- [x] 3.1.2 Finish mapping: budget-capped → `"budget"`; a stop-string
      request → `"stop"`; toy-model EOG (if the fixture can emit it) →
      `"eos"`. Each also asserts the OTHER reasons did not fire.
- [x] 3.1.3 `health` before load reports `loading`, after `ready`
      (drive by calling the handler around a stubbed/loaded engine).
      **DEVIATION**: a serial loop cannot genuinely answer *during*
      load — stdin is not read until `LlmEngine.load` returns, so the
      wire can never carry `loading` in v1. Rather than fake it, the
      state is an explicit `Serve.setState` seam the test drives
      through both values; Unit 4's reader thread is what makes a real
      during-load answer possible, and 4.1 owns that assertion.
- [x] 3.1.4 `shutdown` drains: a request in flight completes its done
      line before exit; EOF behaves identically.

### 3.2 Coding
- [x] 3.2.1 `chat` op via ChatTemplate (metadata template; refuse with
      an error object when the model ships none — never guess a
      template).
- [x] 3.2.2 Stop strings (spec 4.3) — engine SampleParams.stops if
      wired, else post-hoc truncation in cabra; record which.
- [x] 3.2.3 health/shutdown ops + EOF handling.

### 3.3 Acceptance
- [x] 3.3.1 A scripted 3-turn conversation over the toy model, run
      twice, is byte-identical at temp 0.

#### Unit 3 notes (2026-08-27)
- 3.2.2 resolved to the ENGINE path: `SampleParams.stops` is already
  wired (checked against a rolling detokenized tail), so cabra hands
  stop strings through rather than truncating after the fact — a
  post-hoc trim would already have STREAMED the text it suppresses.
- Two defects the unit tests did not catch, both found by running the
  3.3.1 acceptance for real:
  1. `serveOver` handed Serve a JsonLinesWriter built over a FileWriter
     the helper still owned. JsonLinesWriter stores its sink with `#=`
     from a PLAIN parameter, so it records a BORROW — the sink died on
     return. Empty transcripts, then heap corruption. Serve now owns
     the FileWriter and builds the writer itself.
  2. Turn three rendered to 73 tokens against `--ctx 64`. An
     over-long prompt is never ADMITTED, so the scheduler stayed
     not-done, `runAll` spun to its cap and threw, and the exception
     killed the resident server mid-session. Now: an explicit error
     answer before submit, plus a try/catch so NO engine fault is
     fatal — Unit 2's liveness rule extended past malformed lines.
     Pinned by `promptLongerThanTheContextAnswersAnErrorAndKeepsServing`.
- The per-request step bound is now `promptLen + n + 64` rather than
  `ctx * 4`, which was simultaneously too small for a long prompt and
  unbounded slack for a short one.
- Suite 20/0/1. Acceptance: 3 turns, 3 done lines, 0 errors, exit 0,
  byte-identical across two runs.

## 4. Concurrency — id-multiplexed continuous batching

### 4.1 TDD
- [x] 4.1.1 Two interleaved `generate` requests: chunk lines carry the
      right ids, both done lines arrive, and each request's
      concatenated chunks equal its serial-run output (temp 0) — the
      batching must change SCHEDULING, never CONTENT (the engine's
      Q4_K route makes this exact; assert it).
- [x] 4.1.2 Queue bound: max-seqs+queue full → an explicit busy error
      object, never a hang and never a dropped line.

### 4.2 Coding
- [x] 4.2.1 Reader thread feeding a request queue; the serve loop
      drives `stepOnce` across all in-flight requests (the scheduler's
      continuous batching — its first real multi-client caller).
      **The drive half is DONE** — `handleLine` submits, `drive()` steps
      every in-flight request and emits each done line as it finishes.
      **The reader half is BLOCKED**, on two facts found 2026-08-27:
      (a) cajeta has no non-blocking stdin — only `cajeta.io.net`
      carries O_NONBLOCK — so a single fiber cannot notice a second
      line while the first decodes; (b) cajeta has no OS threads, and
      cooperative cancellation "only fires at a yield point", which a
      blocking `FileReader.read` is not. So a reader FIBER parked in
      `read` cannot be cancelled, and `{"op":"shutdown"}` would hang at
      the `scope` join waiting for it. Sketch that does work once one of
      those is resolved: reader fiber owns a ring of line Strings and
      sends SLOT INDICES over a `Channel<int32>` (int32 sidesteps the
      lend-not-own slot rule for heap T), main fiber does every engine
      call. Needs one of: non-blocking/`poll`-able stdin, an
      interruptible read, or a stdin reader on a real carrier thread.

      **REVISED 2026-08-30 — (a) is inaccurate as written.** The runtime
      already HAS a portable single-fd readiness probe that works on any
      POSIX fd, stdin included: `__cajeta_net_reactor_poll_fd`, built on
      `select()` (`runtime/native/cajeta_net_reactor.c`), with a
      cooperative `Reactor.pollPark(fd, READ)` that yields to other
      fibers instead of blocking the carrier. Measured 2026-08-30:
      `select()` on fd 0 of a pipe correctly reports not-ready with no
      data pending. The capability is not MISSING, it is UNEXPOSED —
      every member of `Reactor` is package-private to
      `cajeta.io.net.reactor`, so cabra cannot reach it.

      **UNBLOCKED 2026-08-30 — both (a) and (b) are now measured, not
      argued.** `FileReader.awaitReadable(int32 timeoutMs)` shipped in
      cajeta main (`ffd03571`); see the archived `pollable-stdin` spec +
      plan. What it settles, and how each was established:
        * (a) is RESOLVED, not merely inaccurate. `awaitReadable` polls
          and parks cooperatively, so a reader fiber never enters a
          blocking `read` and never stalls its carrier. A regular file
          reports ALWAYS-READY by design, so `cabra serve < reqs.jsonl`
          behaves like a pipe. Windows THROWS, documented: Winsock
          `select()` takes only SOCKETs and a console/pipe HANDLE is not
          one — so cabra's reader half is POSIX-only until a native
          `PeekNamedPipe`/`WaitForSingleObject` path exists. Plan for
          that now rather than discovering it on the mingw leg.
        * (b) is RESOLVED BY MEASUREMENT, which matters because the
          pollable-stdin spec had only ARGUED it away ("the park is
          itself a yield point"). `FileReaderAwaitCancelTests` parks a
          waiter for 5s on an idle pipe and cancels at 300ms: it drains
          in under 2s, so `Cajeta.fiberSleepNanos` DOES observe the
          cancellation. Its control (`withTimeoutDrainsABodyThatCannot
          Yield`, a 3s spin with no yield point) takes the full 3s,
          which is what makes the short time mean anything. So
          `{"op":"shutdown"}` will NOT hang at the `scope` join.
        * READINESS IS BYTES, NOT LINES. `awaitReadable` says only that
          a read will not block; a read can land mid-line. The ring-of-
          slots sketch below still needs the caller to carry a partial
          tail across passes — see the worked loop in the method's
          docstring, which `FileReaderAwaitDocExampleTests` executes.

      (b) then dissolves as a consequence: a reader that waits via
      poll-and-park never parks inside a blocking `read`, so there is
      nothing to cancel — the park IS a yield point, and shutdown joins
      cleanly.

      Two real caveats remain, and they are what the fix must address:
      1. Readiness is >=1 BYTE, not a whole line, so a client that
         writes a partial line can still stall a `readLine`. Needs
         incremental buffering, not just a poll.
      2. WINDOWS: Winsock `select()` accepts only SOCKETs, and a console
         or pipe HANDLE is not one — so this route is POSIX-only unless
         a Windows path is written.

      So the blocker is now a stdlib API decision (what to expose, and
      what Windows does), not a missing runtime capability.
      **CLOSED 2026-08-31** (LineReader + Serve.runLoop/driveStep;
      LineReaderTest + ServeLoopTest, 30/0): the pump fiber owns the fd
      via awaitReadable(200) poll-and-park (bounded, so close() ends it
      on an idle stdin), splits lines with a carried tail, and sends
      ring-slot INDICES over a bounded Channel<int32> - the plan sketch
      verbatim. Three language traps were measured on the way and are
      recorded in code comments: #=-spawn double-free, =-spawn-to-field
      join-blocking the spawning frame (two-step move-out is the
      shape), and stack-Optional RELAY losing the present flag (callers
      read the channel directly).

- [x] 4.2.2 Per-request sink demux by scheduler request id → caller id.

### 4.3 Acceptance
- [x] 4.3.1 An N-client driver script completes with per-id outputs
      equal to serial runs. Blocked on 4.2.1: from a pipe, lines cannot
      **CLOSED 2026-08-31**: exact per-id parity against solo runs is
      ServeLoopTest.readerFedRequestsOverlapAndKeepTheirContent (toy,
      in-suite); the real-model arm ran the 8B Q4_K_M on vulkan with a
      scripted 2-client session — chunks for ids 1 and 2 INTERLEAVE in
      the transcript (the chat admitted mid-decode of the generate),
      finishes eos/budget, and 19 session-attributed records landed in
      app.jsonl via --verbose. bld.sh gained the logging classpath it
      was missing since 2026-08-30.

      arrive during a drive, so N clients cannot actually overlap yet.
      The equality it would assert is already pinned in-process by
      4.1.1 (`interleavedRequestsKeepTheirOwnContent`).

## 5. The 72B acceptance + docs

### 5.1 TDD
- [ ] 5.1.1 (manual, recorded here) The spec §9 script against
      Qwen2.5-VL-72B on vulkan: three sequential prompts, one load,
      each `finish:"eos"`; a capped one reports `budget`; usage rates
      within the measured envelope (prefill ~15 ms/tok warm, decode
      ~246 ms/tok).

### 5.2 Coding
- [ ] 5.2.1 `docs/protocol.md` — the JSONL op set, one example per op,
      the stderr contract (user-facing doc; the spec stays the
      workflow artifact).
- [ ] 5.2.2 README with the ecosystem map (mirror of cajeta-llm's).

### 5.3 Acceptance
- [ ] 5.3.1 Julian drives a session against the 72B through cabra.

---

## 6. Session model and the transport-neutral core

*Satisfies spec §4.4, §4.5, §5.2, §5.4.3. Depends on nothing; everything
here is testable without a socket, a pipe or a model.*

### 6.1 TDD
- [x] 6.1.1 An opened session returns an id, and a message naming it is
      routed to it.
- [x] 6.1.2 A session survives its connection: closing and reattaching by
      id reaches the same session, with its context still warm.
- [x] 6.1.3 A message naming an expired or unknown session is refused
      explicitly, NOT given a silently fresh one (§5.2.5) — a client that
      cannot tell the difference will assume its context is cached when
      it is gone.
- [x] 6.1.4 An idle session past its expiry is reclaimed, and its slot
      returns to the pool.
- [x] 6.1.5 Two sessions on one channel do not perturb each other's
      output, cancellation or parameters.
- [x] 6.1.6 Each error kind (§4.5.2) is produced by the condition that
      should produce it, and carries its kind rather than only text.
- [x] 6.1.7 An error AFTER tokens have streamed terminates the turn with
      reason `error`, distinguishably from one before generation starts.
- [x] 6.1.8 NEGATIVE ARM: classification never reads engine exception
      text. Change an `LlmException` message and every kind still
      resolves the same way.

### 6.2 Coding
- [x] 6.2.1 The channel seam: read a message, write a message, close.
- [x] 6.2.2 An in-memory channel implementing it, so 6.1.* run with no
      I/O.
- [x] 6.2.3 Session registry: open, resume by id, close, expire.
- [x] 6.2.4 Error kinds and the `error` terminating reason.
- [x] 6.2.5 The serving core, transport-blind: it never branches on which
      transport carries it.

### 6.3 Acceptance
- [x] 6.3.1 The whole unit runs without a model, a socket or a pipe.
- [~] 6.3.2 The stdio transport (§3) is re-expressed over the seam with
      its behaviour unchanged — same op set, same ids.

**Unit 6 landed 2026-08-31** (SessionCoreTest, 38/0): MsgChannel seam +
MemChannel, ErrKind (structural, 6.1.8 pinned by a throw whose text
NAMES other kinds), SessionRegistry (scripted clock; OPEN/GONE/UNKNOWN
three-valued so 5.2.5 can say WHICH), Wire renderers, ServeCore with
the 4.4 pre/post-stream error split. 6.3.2 is deliberately [~]: the
unit-6 TurnPort drives a turn synchronously, which is right for a
scripted port and WRONG for the engine - real turns must be
submit-based so sessions interleave (7.1.6). The stdio re-expression
rides with unit 7's engine adapter rather than forcing a blocking
regression now.

## 7. Host mode over WebSocket

*Satisfies spec §5.1.2, §5.3, §5.4.1, §5.5. Depends on unit 6.*
**BLOCKED until `cajeta-llm-plan` 15.2.8 is fixed** — host mode is N
concurrent sequences in one engine, and the engine crashes above one at
the default chunk.

### 7.1 TDD
- [ ] 7.1.1 Two clients connected at once each get their own session and
      their own output.
- [ ] 7.1.2 Two clients share ONE model load — the measurement that
      justifies host mode at all (§5.1.4).
- [ ] 7.1.3 A client that dies without closing has its session reclaimed
      by expiry, not leaked.
- [ ] 7.1.4 A connection without a valid token is closed before any other
      op is processed.
- [ ] 7.1.5 Beyond capacity, a request queues and later runs; beyond the
      queue bound it is shed with an explicit busy error.
- [ ] 7.1.6 A client that stops reading does not stall other sessions.

### 7.2 Coding
- [x] 7.2.1 A WebSocket channel over `dev.cajeta.http` implementing the
      unit-6 seam.
- [x] 7.2.2 Listener, accept loop, per-connection session binding.
- [x] 7.2.3 Token check on connect.
- [ ] 7.2.4 Capacity, queue bound and shedding.


**Unit 7 status 2026-08-31 — BLOCKED on a runtime lost-wake bug.**
Landed: Host + WsConn (accept fiber, per-conn reader/writer fibers with
bounded outbox + shed, auth gate, unit-6 sessions, Serve-style demux
with a connection column). The SINGLE-client path is proven live end to
end (tools/repro/HostProbe.cajeta, cpu + vulkan: connect, upgrade,
auth, open, streamed generate, shutdown, exit 0). The TWO-client path
wedges 100% deterministically in the RUNTIME, not in cabra: at wedge
every thread is parked (main + 6 carriers futex_wait, reactor ep_poll)
while fully FLUSHED ws frames sit unread on the client sockets — the
reactor-woken fibers are never resumed by any carrier. A println in
the dispatch path masks it (scheduling side effect); a forced 1 ms
main park per step does NOT (so not starvation — a dropped wake).
Repro: build tools/repro/HostProbe.cajeta against cabra.cja (any
backend) and run; wedges after both generates dispatch. HostTest.cajeta
carries the suite-side tests, currently wedging the suite — REMOVE it
from the tree until the runtime fix, then restore. Compiler-side next:
the EPOLLONESHOT wake -> carrier ready-deque handoff in
cajeta_net_reactor.c / the carrier futex wake.

### 7.3 Acceptance
- [ ] 7.3.1 N terminals against one host produce N conversations from one
      resident model, with resident memory close to a single load rather
      than N.

## 8. Client mode

*Satisfies spec §5.1.3. Depends on unit 7.*

### 8.1 TDD
- [ ] 8.1.1 cabra connects to a host and drives one conversation.
- [ ] 8.1.2 A dropped connection resumes the SAME session by id, and the
      prefix cache is still warm — measured as a re-prefill that does not
      happen, not merely as a successful reconnect.
- [ ] 8.1.3 Connecting to no host fails with a clear message and does not
      silently start one (spec: no implicit server start).

### 8.2 Coding
- [ ] 8.2.1 Client-side channel and session handling.
- [ ] 8.2.2 `--connect` on the existing verbs.

### 8.3 Acceptance
- [ ] 8.3.1 The same conversation behaves identically embedded and
      connected, apart from latency.

## 9. Diagnostics as records

*Satisfies spec §8.2. Depends on the engine's `cajeta-llm-plan` §11.8
callback landing first.*

### 9.1 TDD
- [x] 9.1.1 Records arrive attributed to the session that produced them,
      with two sessions in flight — the case the current text stream
      cannot express at all.
- [x] 9.1.2 A handler that throws does not take the turn down.
- [x] 9.1.3 A slow handler is not on the token path: the handler enqueues
      and returns, and per-token latency is unchanged with a deliberately
      slow consumer attached.
- [x] 9.1.4 With no callback registered, nothing is recorded and no
      string is formatted.

### 9.2 Coding
- [x] 9.2.1 Register a callback with the engine; take the record, return.
- [x] 9.2.2 Publish off the engine's thread: log, and optionally forward a
      session's records to the client that owns it.
- [x] 9.2.3 Any retrospective buffer cabra wants is cabra's, sized by
      cabra's policy (§8.2.2).

### 9.3 Acceptance
- [x] 9.3.1 A route decision taken during one client's turn is visible in
      cabra's log attributed to that client's session.

**CLOSED 2026-08-31** (RecordBridge + RecordBridgeTest, 26/0): enqueue
on the engine thread, bounded ring (CAP 512, shed-and-count beyond),
drainer fiber renders onto dev.cajeta.logging — DEBUG chatter,
launch-failure at ERROR. 9.1.3 proven structurally: with a 25 ms/line
consumer, generation finishes while publishing lags, then flush
delivers everything. NOTE the spawn-binding trap found here: handing a
spawn to a field needs declare-local-then-#=-move-out — `#= spawn`
double-frees (inactivation is declaration-only,
LocalVariableDeclaration.cpp:1155) and `field = spawn` join-blocks the
spawning frame. Measured, three shapes.

## 10. The multi-client 72B acceptance

*Satisfies spec §5.1.4. Depends on units 7–9.*

### 10.1 TDD
- [ ] 10.1.1 (manual, recorded here) Three clients against one 72B host:
      each completes, outputs are per-client correct, and resident memory
      is one model load rather than three.

### 10.2 Coding
- [ ] 10.2.1 `docs/protocol.md` gains the session ops, error kinds and
      the WebSocket transport.

### 10.3 Acceptance
- [ ] 10.3.1 Julian drives three concurrent conversations against one
      resident 72B.
