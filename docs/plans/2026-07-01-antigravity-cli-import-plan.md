---
date: 2026-07-01
topic: antigravity-cli-import
stage: plan
status: draft
source: conversation
---

# Antigravity CLI Import Plan

## Goal

Deliver a historical importer for Antigravity CLI conversation databases so its
runs appear in AgentMonitor's session browser, usage/cost rollups, and
trace-quality view, realizing
`docs/specs/2026-07-01-antigravity-cli-import-spec.md`. Every `Done When` below
traces to that spec's End State & Success Criteria.

## Scope

### In Scope

- Read-only decode of `~/.gemini/antigravity-cli/conversations/**/*.db` protobuf.
- New `src/import/antigravity.ts` (+ decode helper) on the existing importer contract.
- Import orchestration wiring (`src/import/index.ts`) and cost via the pricing engine.
- `agent_type="antigravity"` with `google`/`gemini` model classification.
- Watcher startup-sync path so sessions surface in the browser (`watched_files`).
- Step-type → event-taxonomy mapping; docs refresh.

### Out of Scope

- Live tailing of active `.db` files (follow-on; reuses the decoder on file-change).
- Gemini CLI OTEL/import path.
- Antigravity **IDE** (`~/.antigravity/`).
- Provider-quota header for the Monitor.

## Assumptions And Constraints

- Payloads are plaintext protobuf (verified in recon); no decryption needed.
- Usage/model ride Google's stable public `UsageMetadata`; trajectory/step envelope
  is private `exa.cortex_pb`/`gemini_coder` and must be pinned from descriptors.
- Repo convention: red/green TDD, `.js` extension in TS ESM imports, all SQL in
  query modules, cache-inclusive `tokens_in` invariant.
- No new heavy runtime dep unless justified: prefer a small in-repo protobuf
  wire-reader over adding a proto toolchain to the runtime path.

## Map Before You Cut

**Assumptions Verified (importer contract):** Each importer exports the same trio —
`discover*Logs(dir, {excludePatterns}) → string[]`, `parse*File(filePath, options)
→ NormalizedIngestEvent[]`, `hashFile(filePath)` — and `processFile` selects
`hashFn`/`parseFn` by `source` while `runImport` discovers + loops per source
(`src/import/index.ts:97-121,146-165`; `src/import/codex.ts:76-80,326-329`). Adding
a source is additive: extend the `ImportSource` union, the two selectors, and the
discovery loop.

**Assumptions Verified (event contract):** `NormalizedIngestEvent.agent_type` is an
open `string`, not a closed union (`src/contracts/event-contract.ts:35-55`), so
`agent_type="antigravity"` needs no contract change; classification/pricing/UI are
where the new identity must be taught.

**Assumptions Verified (session-browser seam):** The browser is fed by the watcher's
`syncAll*Files` writing `watched_files` with `integration_mode` + `fidelity`
(`'summary'`/`'full'`) — a projection separate from `runImport`'s cost path
(`src/watcher/service.ts:56-96,201`; `src/watcher/index.ts:49-105`). Historical
browser visibility therefore needs a `syncAllAntigravityFiles` startup path, not
just `runImport`. Live chokidar tailing is the deferred follow-on.

**Thinnest seam:** one shared decoder + parser feeding two thin adapters (import
loop + watcher startup sync), mirroring exactly how Codex is wired today.

## Task Breakdown

### Task 1: Pin the Antigravity proto field map

**Objective**

Produce an authoritative, checked-in field-number map for the usage/model/step
protos and the `CORTEX_STEP_TYPE_*` integer→name enum, so decoding is grounded not
guessed.

**Files**

- Create: `docs/specs/baselines/antigravity-proto-fieldmap.md`
- Create: `src/import/antigravity/fieldmap.ts` (typed constants used by the decoder)

**Dependencies** None

**Implementation Steps**

1. Extract embedded `FileDescriptorProto` (rawDesc) from
   `/Applications/Antigravity.app/Contents/Resources/bin/language_server` for
   `exa.cortex_pb`, `exa.eval_pb`, `gemini_coder`, and the vendored `UsageMetadata`.
2. Record message → field-number → name/type for: the step envelope
   (`step_payload`, `step_type`), `gen_metadata` generation record, and
   `UsageMetadata` (prompt/candidates/thoughts/cached/total token fields).
3. Enumerate `CORTEX_STEP_TYPE_*` with integer values; capture in the baseline doc.
4. Encode the subset the parser needs as typed constants in `fieldmap.ts`.
5. If descriptor extraction is blocked, fall back to the recon-derived numbers and
   mark each as `unverified` in the baseline doc.

**Verification**

- `python3 -c` / `protoc --decode` round-trips one real blob field against the map.
- Observed `step_type` ints (14/15/23/90/98 from recon) resolve to enum names.

**Done When**

- Field map covers usage, model, and step envelope with numbers marked verified or
  unverified. (Spec Success Criteria #7; Open Question #1.)

### Task 2: Protobuf decode helper with fixtures

**Objective**

A small, dependency-light protobuf wire-reader that decodes an Antigravity blob into
a typed intermediate, covered by fixture tests (red first).

**Files**

- Create: `src/import/antigravity/proto.ts`
- Create: `tests/import/antigravity-proto.test.ts`
- Create: `tests/fixtures/antigravity/sample-conversation.db` (redacted copy)

**Dependencies** Task 1

**Implementation Steps**

1. Copy one real `conversations/<uuid>.db` into fixtures; scrub any sensitive
   transcript text while preserving structure + token/model fields.
2. Write failing tests asserting decoded model id and token counts (incl. thoughts)
   for known fixture rows.
3. Implement the wire-reader (varint/length-delimited walk) keyed by `fieldmap.ts`;
   expose `decodeStep`, `decodeGenMetadata`, `decodeUsage`.
4. Green the tests.

**Verification**

- `pnpm test tests/import/antigravity-proto.test.ts` passes.

**Done When**

- Decoder returns model + token buckets matching fixture expectations. (Criteria #2, #7.)

### Task 3: `antigravity.ts` importer (discover / parse / hash)

**Objective**

Implement the importer trio emitting `NormalizedIngestEvent[]` with
`agent_type="antigravity"`, correct token accounting, and step→taxonomy mapping.

**Files**

- Create: `src/import/antigravity.ts`
- Create: `tests/import/antigravity-parse.test.ts`

**Dependencies** Task 2

**Implementation Steps**

1. Red tests: fixture DB → expected session_start + llm_response + tool_use events.
2. `discoverAntigravityLogs(dir, {excludePatterns})` globbing
   `conversations/**/*.db` under `~/.gemini/antigravity-cli` (env-overridable).
3. `parseAntigravityFile(filePath, options)`: open DB read-only, iterate `steps`
   ordered by `idx`, decode via Task 2, map `CORTEX_STEP_TYPE_*` → `event_type`
   (unmapped → typed generic, never dropped).
4. Token accounting: store `tokens_in` per the cache-inclusive invariant (subtract
   cached), attribute thoughts tokens to the agreed lane; leave `cost_usd` unset
   (Task 5 computes it via pricing at import).
5. `hashFile(filePath)` over raw bytes for `import_state`.
6. Green the tests.

**Verification**

- `pnpm test tests/import/antigravity-parse.test.ts` passes; asserts one session per
  DB keyed to the conversation UUID.

**Done When**

- Parser emits taxonomy-mapped events with correct `tokens_in`/thoughts. (Criteria #1, #2, #4.)

### Task 4: Model classification + pricing coverage

**Objective**

Teach classification/pricing that Antigravity models are provider `google` / family
`gemini`, and confirm `gemini.json` resolves the observed models.

**Files**

- Modify: `src/pricing/model-classification.ts`
- Modify: `src/pricing/data/gemini.json` (only if coverage gaps found)
- Create/Modify: `tests/pricing/gemini-classification.test.ts`

**Dependencies** Task 3

**Implementation Steps**

1. Red tests: `gemini-pro-*` / `Gemini 3.1 Pro` classify to google/gemini with a
   resolvable tier; an unknown model surfaces pricing-status `unknown` (not zero).
2. Add classification/alias entries; add pricing rows only for genuinely missing
   models.
3. Wire `cost_usd` computation into the antigravity import path via the existing
   `PricingRegistry` (match how codex import computes cost).

**Verification**

- `pnpm test tests/pricing/gemini-classification.test.ts` passes; re-run Task 3
  tests to confirm non-zero `cost_usd`.

**Done When**

- Imported events carry `cost_usd`; unresolved models are honest, never silent-zero.
  (Criteria #3.)

### Task 5: Wire into import orchestration

**Objective**

Make `amon import` discover and process Antigravity DBs idempotently.

**Files**

- Modify: `src/import/index.ts`
- Modify: `src/cli/*` import command (add `--source antigravity`)
- Create: `tests/import/antigravity-idempotent.test.ts`

**Dependencies** Task 3

**Implementation Steps**

1. Extend `ImportSource` union with `antigravity`; add `antigravityDir?` to options.
2. Add antigravity to `processFile` hash/parse selectors and to `runImport`
   discovery + loop.
3. Red/green a test: second import over unchanged DB reports `skippedUnchanged`.

**Verification**

- `pnpm test tests/import/antigravity-idempotent.test.ts` passes.
- `amon import --source antigravity --dry-run` lists events without writing.

**Done When**

- Re-running import over unchanged DBs is a no-op. (Criteria #5.)

### Task 6: Watcher startup sync for session-browser visibility

**Objective**

Add a `syncAllAntigravityFiles` startup path so imported sessions appear in `/app/`
with honest coverage flags.

**Files**

- Modify: `src/watcher/service.ts`
- Modify: `src/watcher/index.ts` (or the module owning `syncAll*Files`)
- Create: `tests/watcher/antigravity-sync.test.ts`

**Dependencies** Task 3

**Implementation Steps**

1. Extend `WatchedSource` with `antigravity`; add root
   `~/.gemini/antigravity-cli/conversations`.
2. Implement `syncAllAntigravityFiles` writing `watched_files` with
   `integration_mode="antigravity-sqlite"` and a `fidelity`/`coverage_json` that
   reflects decoded richness (Open Question #3 in spec).
3. Call it from startup sync + periodic resync (leave chokidar live-tailing out —
   deferred follow-on).
4. Red/green a test asserting a fixture DB yields a browsable session row.

**Verification**

- `pnpm test tests/watcher/antigravity-sync.test.ts` passes.

**Done When**

- Antigravity sessions are listed and agent-filterable in the browser with correct
  coverage flags. (Criteria #6.)

### Task 7: Docs + agent-filter surface

**Objective**

Reflect the new agent everywhere operators look, and refresh reference docs.

**Files**

- Modify: `src/api/filter-options.ts` (if agent values are enumerated) / frontend
  agent labels+colors
- Modify: `docs/system/ARCHITECTURE.md` (capability matrix + directory map)
- Modify: `docs/system/FEATURES.md`, `docs/system/OPERATIONS.md` (import command, env var)
- Create: `hooks/antigravity/README.md` (setup: point at conversations dir)

**Dependencies** Tasks 5, 6

**Implementation Steps**

1. Ensure `agent_type=antigravity` appears in filter options + has a UI label/color.
2. Add an Antigravity capability row mirroring the Codex telemetry matrix.
3. Document `amon import --source antigravity` and any `AGENTMONITOR_*`/dir env var.
4. Flip the spec `status:` to `in-progress`, and to `complete` when shipped.

**Verification**

- `pnpm frontend:check` (if frontend touched); manual `/app/` agent filter shows
  Antigravity.

**Done When**

- Docs match shipped behavior; agent is filterable in `/app/`. (Spec close-out.)

## Risks And Mitigations

- **Private-proto drift across Antigravity versions** → pin numbers from descriptors
  (Task 1) + fixture guard (Task 2); usage rides the stable public schema.
- **Cache-inclusive double-bill (~10x)** → enforce the `tokens_in` invariant in
  Task 3 with an explicit fixture assertion.
- **Concurrent writes to a live session DB** → open read-only, tolerate partial rows,
  skip on decode error rather than aborting the run.
- **Fixture leaks private transcript text** → scrub during Task 2, keep only
  structural + numeric fields.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| #1 session-per-DB, UUID-keyed | `pnpm test tests/import/antigravity-parse.test.ts` | one session row per DB, keyed to conversation UUID |
| #2 usage/tokens/thoughts + invariant | `pnpm test tests/import/antigravity-proto.test.ts tests/import/antigravity-parse.test.ts` | decoded token buckets match fixture; `tokens_in` cache-net |
| #3 cost via pricing, no silent-zero | `pnpm test tests/pricing/gemini-classification.test.ts` | non-zero `cost_usd`; unknown model → pricing-status `unknown` |
| #4 step→taxonomy, no drops | `pnpm test tests/import/antigravity-parse.test.ts` | unmapped step_type emits typed generic, not dropped |
| #5 idempotent re-import | `pnpm test tests/import/antigravity-idempotent.test.ts` | second run reports `skippedUnchanged` |
| #6 browser visible + filterable | `pnpm test tests/watcher/antigravity-sync.test.ts` | fixture DB yields browsable, agent-filterable session |
| #7 pinned field numbers + drift guard | `pnpm test tests/import/antigravity-proto.test.ts` | decode matches baseline field map |
| Pre-push gate | `pnpm lint && pnpm build && pnpm test` | all green |

## Handoff

- Start at Task 1 (descriptor extraction) — it unblocks grounded decoding.
- Tasks 4/5/6 all depend only on Task 3 and can proceed in parallel after it.
- Keep the spec's Open Questions #2–#4 in view; resolve #3 (coverage flags) inside
  Task 6.
