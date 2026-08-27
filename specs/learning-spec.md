# on-the-fly learning — umbrella spec

STATUS: DRAFT SKELETON — Julian's five directional decisions are
recorded (2026-08-27); this umbrella decomposes into the several specs
he called for, each authored with him before its code.

## 1. Definition

A served model that learns during service. Spans three projects: cabra
(capture, retrieval, triggering, lifecycle), cajeta-llm (adapter
application, the backward pass), and cajeta-ml (the training role —
optim/train own the torch seam by prior decision). This umbrella fixes
the requirements and the decomposition; mechanism detail lives in the
child specs.

## 2. Decided requirements (Julian, 2026-08-27)

- **2.1 Sources.** Learns from conversation — feedback and user
  responses. ADDITIONALLY the harness can look up data from **trusted
  sources**, **spot its own errors**, and **look up the truth when
  doubted** — retrieval and self-verification are part of the learning
  loop, not a separate feature.
- **2.2 Persistence.** The model is **checkpointed periodically**, with
  **deltas stored between checkpoints** to maximize compression (a
  write-ahead log for weight/adapter state). A purposeful shutdown
  stores final state; restart resumes from checkpoint + delta replay.
- **2.3 Mechanism.** A **combination** of memory-tier and weight-tier
  learning, routed by **the nature of the correction** — which routing
  is itself spec-worthy (§3.4).
- **2.4 Models.** Bring-up on the **8–12B** class; identify several
  candidates, possibly **specialized to specific tasks or
  capabilities** (a model-set decision, §3.5).
- **2.5 Trigger.** **Autograd training passes triggered by feedback** —
  learning is event-driven, not continuous. Julian's further direction:
  adapt autograd training to **key augmentation or updates for given
  token associations** — targeted-update mechanisms (embedding/token-
  association editing) are in scope beside adapter training, not
  replaced by it.

## 3. The child specs (each: author with Julian, then plan)

- **3.1 learning-memory** (cabra) — conversation capture, retrieval
  over trusted sources, the doubt→verify→correct loop of 2.1. No
  engine changes; nearest-term.
- **3.2 learning-training** (cajeta-llm + cajeta-ml) — the backward
  pass through decoder blocks (the engine is deliberately tape-free/
  forward-only today), LoRA/QLoRA adapter application in `Linear`,
  optimizer via `dev.cajeta.ml`'s training core; plus the 2.5 targeted
  token-association update mechanism as its own section.
- **3.3 learning-persistence** — checkpoint format, the delta log
  (what a delta IS for adapters vs token-association edits), replay,
  compaction, clean-shutdown state.
- **3.4 learning-routing** — correction-nature → mechanism policy:
  which corrections become memory, which become weight updates, which
  demand verification first.
- **3.5 model-set** — the 8–12B candidates and any per-task
  specialization; the bring-up order.

## 4. Constraints known today

- The engine has no autograd; backward kernels for matmul/rmsnorm/
  rope/attention/GLU are new engine work (multi-unit).
- Training numerics against a quantized frozen base (QLoRA-style)
  need their own validation discipline — same measure-don't-reason
  rules as the inference kernels.
- 122 GB UMA bounds concurrent serve+train residency; the 8–12B class
  fits both comfortably, which is part of why 2.4 starts there.
- cabra's protocol (cabra-spec §3.1) gains learning ops when 3.1
  lands; the JSONL op set was designed knowing this.
