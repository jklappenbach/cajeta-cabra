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
- [ ] 2.1.1 Line parser: a well-formed `generate` request parses to op,
      id, prompt, sampling fields; absent fields take defaults; a
      malformed line yields an error object with `"id":null` and the
      loop CONTINUES (the negative half: the server must not die).
- [ ] 2.1.2 Response encoder: chunk, done (finish + usage), health, and
      error objects each serialize to one line of valid JSON — asserted
      by parsing them back with the codec, not by string comparison.
- [ ] 2.1.3 End-to-end over the TOY model (cajeta-llm's
      `src/test/fixtures/gguf/toy.gguf` via the sibling path): a
      `generate` with `"n":4` yields ≥1 chunk line, then a done line
      with `finish:"budget"` and a usage block whose token counts match
      the chunk stream.

### 2.2 Coding
- [ ] 2.2.1 `Main.main` — arg parse (`serve --model --ctx --max-seqs
      --device`), engine load, serve loop.
- [ ] 2.2.2 `Protocol` — request parse (codec JSON) + response emit;
      stdout write is line-atomic; flush per line.
- [ ] 2.2.3 `Serve` — the serial loop: read line, dispatch op, drive
      the engine (`submitTokens`/`submitText` + `runAll`), stream via a
      `TokenSink` that emits chunk lines (EOG ids filtered through
      `engine.isEog` — spec 4.2), answer done with finish + usage.
- [ ] 2.2.4 stderr discipline: every diagnostic through a logger that
      writes fd 2; nothing but protocol objects on fd 1 (the engine's
      own route prints already go to stdout — REDIRECT or accept them
      on stderr via engine option; resolve which and record it here).

### 2.3 Acceptance
- [ ] 2.3.1 `printf '...generate...' | cabra serve --model toy.gguf`
      emits exactly parseable JSONL on stdout and exits 0 on EOF.

## 3. Chat op, finish reasons, health, shutdown

### 3.1 TDD
- [ ] 3.1.1 `chat` renders through the model's template: over a
      template-bearing fixture, the rendered ids equal
      tokenizer.encode(template.render(messages)) — the same
      no-double-BOS discipline chatMain already pins.
- [ ] 3.1.2 Finish mapping: budget-capped → `"budget"`; a stop-string
      request → `"stop"`; toy-model EOG (if the fixture can emit it) →
      `"eos"`. Each also asserts the OTHER reasons did not fire.
- [ ] 3.1.3 `health` before load reports `loading`, after `ready`
      (drive by calling the handler around a stubbed/loaded engine).
- [ ] 3.1.4 `shutdown` drains: a request in flight completes its done
      line before exit; EOF behaves identically.

### 3.2 Coding
- [ ] 3.2.1 `chat` op via ChatTemplate (metadata template; refuse with
      an error object when the model ships none — never guess a
      template).
- [ ] 3.2.2 Stop strings (spec 4.3) — engine SampleParams.stops if
      wired, else post-hoc truncation in cabra; record which.
- [ ] 3.2.3 health/shutdown ops + EOF handling.

### 3.3 Acceptance
- [ ] 3.3.1 A scripted 3-turn conversation over the toy model, run
      twice, is byte-identical at temp 0.

## 4. Concurrency — id-multiplexed continuous batching

### 4.1 TDD
- [ ] 4.1.1 Two interleaved `generate` requests: chunk lines carry the
      right ids, both done lines arrive, and each request's
      concatenated chunks equal its serial-run output (temp 0) — the
      batching must change SCHEDULING, never CONTENT (the engine's
      Q4_K route makes this exact; assert it).
- [ ] 4.1.2 Queue bound: max-seqs+queue full → an explicit busy error
      object, never a hang and never a dropped line.

### 4.2 Coding
- [ ] 4.2.1 Reader thread feeding a request queue; the serve loop
      drives `stepOnce` across all in-flight requests (the scheduler's
      continuous batching — its first real multi-client caller).
- [ ] 4.2.2 Per-request sink demux by scheduler request id → caller id.

### 4.3 Acceptance
- [ ] 4.3.1 An N-client driver script completes with per-id outputs
      equal to serial runs.

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
