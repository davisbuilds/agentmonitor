---
date: 2026-07-01
topic: antigravity-cli-import
stage: plan
status: in-progress
source: conversation
---

# Antigravity CLI Import Plan

## Goal

Deliver a historical importer for Antigravity CLI conversation databases so its
runs appear in AgentMonitor's session browser, usage/cost rollups, and
trace-quality view, realizing
`docs/specs/2026-07-01-antigravity-cli-import-spec.md`. Every `Done When` below
traces to that spec's End State & Success Criteria.

> Revised after plan critique (2026-07-01): the session browser is fed by
> `browsing_sessions` via a `ParsedSession` projection, **not** by `watched_files`.
> The seam is now one shared decoder → **two** projections (events + ParsedSession).

## Scope

### In Scope

- Read-only decode of `~/.gemini/antigravity-cli/conversations/**/*.db` protobuf.
- **Event projection**: `src/import/antigravity.ts` → `NormalizedIngestEvent[]`
  (with cost computed in-parser) → `events`/`sessions`/`agents` for usage rollups.
- **Session projection**: `src/parser/antigravity-sessions.ts` → `ParsedSession` →
  `insertParsedSession` → `browsing_sessions`/`messages`/`tool_calls`/`session_items`
  for the browser, search, analytics, and trace-quality.
- Import orchestration wiring (`src/import/index.ts`) + watcher startup sync.
- `agent_type="antigravity"` (events) and `browsing_sessions.agent="antigravity"`,
  with `google`/`gemini` model classification + pricing.

### Out of Scope

- Live tailing of active `.db` files (follow-on; reuses the decoder on file-change).
- Gemini CLI OTEL/import path; Antigravity **IDE** (`~/.antigravity/`).
- Provider-quota header for the Monitor.

## Assumptions And Constraints

- Payloads are plaintext protobuf (verified in recon); no decryption needed.
- Usage/model ride Google's stable public `UsageMetadata`; the trajectory/step
  envelope is private `exa.cortex_pb`/`gemini_coder`, pinned from descriptors.
- Repo convention: red/green TDD, `.js` extension in TS ESM imports, all SQL in
  query modules, cache-inclusive `tokens_in` invariant, cost computed in the parser.
- Prefer a small in-repo protobuf wire-reader over adding a proto toolchain.

## Map Before You Cut

There are **three** persistence paths, and they consume different shapes — verified
this pass against source:

1. **Event/usage path.** `parse*File → NormalizedIngestEvent[] → insertEvent`, which
   upserts `agents`/`sessions` and inserts `events` (`src/db/queries.ts:339-341,385`).
   Cost is computed **inside the parser** via `pricingRegistry.calculate`
   (`src/import/codex.ts:203,220`), not in orchestration. Powers Monitor + event-based
   usage/cost rollups.
2. **Browser/search/analytics/trace-quality path.** These read `browsing_sessions`
   (`src/db/v2-queries.ts:168,181,261`), filtered by the `agent` column, plus
   `messages`/`tool_calls`/`session_items`. Those tables are populated by
   `insertParsedSession(db, parsed)` (`src/parser/claude-code.ts:410`) from a
   `ParsedSession` (`:95`), whose `metadata.agent` sets `browsing_sessions.agent`.
   `integration_mode`/`fidelity` are **columns on `browsing_sessions`**
   (`src/db/schema.ts:407-408,431-435`). `src/parser/codex-sessions.ts` is the mirror
   to copy for a non-Claude source.
3. **De-dupe ledger.** `watched_files` has only
   `file_path/file_hash/file_mtime/status/last_parsed_at` (`src/db/schema.ts:669-675`).
   It carries **no** `integration_mode`/`fidelity`/`coverage_json`; writing it does
   nothing for browser visibility. `syncAll*Files`/`upsertWatchedFile` live in
   `src/watcher/index.ts`; the `integration_mode`/`fidelity` seen in
   `src/watcher/service.ts:62-70` are **ephemeral SSE literals** on the live path, not
   stored state.

**Thinnest seam:** one shared proto decoder (Task 2) feeding **two projection
builders** — a `NormalizedIngestEvent[]` builder (Task 3) and a `ParsedSession`
builder (Task 6) — each handed to its existing insert path. `coverage_json` honesty
(spec Open Question #3) is decided in the trace-quality projection layer
(`src/trace-quality/*`), which reads the `messages`/`session_items` that Task 6
populates — not in the watcher.

## Task Breakdown

### Task 1: Pin the Antigravity proto field map (gates criterion #7) — DONE

> Completed 2026-07-01. Descriptors extracted from the `language_server` binary via
> `protodump`; `Step` envelope, 120-kind step taxonomy, and `UsageMetadata` token
> fields are descriptor-pinned in `docs/specs/baselines/antigravity-proto-fieldmap.md`
> (with the generated `fieldmap.ts` captured as an appendix). The `.ts` module itself
> lands in Task 2 with its consumer — an unconsumed constants module trips the
> dead-code gate. Private `exa.cortex_pb` payload internals were not recoverable by
> protodump and are deferred to fixture verification in Task 2 (documented, not guessed).

**Objective**

Authoritative field-number map for usage/model/step protos and the step-kind
taxonomy, extracted from the binary — not guessed.

**Files**

- Create: `docs/specs/baselines/antigravity-proto-fieldmap.md` (incl. generated map appendix)

**Dependencies** None

**Implementation Steps**

1. Extract embedded `FileDescriptorProto` (rawDesc) from
   `/Applications/Antigravity.app/Contents/Resources/bin/language_server` for
   `exa.cortex_pb`, `exa.eval_pb`, `gemini_coder`, and vendored `UsageMetadata`.
2. Record message → field-number → name/type for the step envelope
   (`step_payload`, `step_type`), the `gen_metadata` record, and `UsageMetadata`
   (prompt/candidates/thoughts/cached/total).
3. Enumerate `CORTEX_STEP_TYPE_*` integer values into the baseline doc.
4. Encode the needed subset as typed constants in `fieldmap.ts`.

**Verification**

- `protoc --decode`/round-trip one real blob field against the map; observed
  `step_type` ints (14/15/23/90/98) resolve to enum names.

**Done When**

- Field map is descriptor-pinned. **If descriptors can't be extracted, criterion #7
  is unmet** — do not silently proceed on recon numbers; escalate the honesty
  trade-off before continuing. (Spec Criteria #7; Open Question #1.)

### Task 2: Protobuf decode helper with fixtures

**Objective**

A dependency-light protobuf wire-reader decoding an Antigravity blob into a typed
intermediate, covered by fixture tests (red first).

**Files**

- Create: `src/import/antigravity/fieldmap.ts` (lift from the baseline doc appendix)
- Create: `src/import/antigravity/proto.ts`
- Create: `tests/antigravity-proto.test.ts`
- Create: `tests/fixtures/antigravity/sample-conversation.db` (redacted copy)

**Dependencies** Task 1

**Implementation Steps**

1. Copy one real `conversations/<uuid>.db` into fixtures; scrub sensitive transcript
   text, preserve structure + token/model fields.
2. Red tests asserting decoded model id and token counts (incl. thoughts) for known
   fixture rows.
3. Implement the wire-reader keyed by `fieldmap.ts`; expose `decodeStep`,
   `decodeGenMetadata`, `decodeUsage`. Green the tests.

**Verification**

- `pnpm test tests/antigravity-proto.test.ts` passes.

**Done When**

- Decoder returns model + token buckets matching fixture expectations. (Criteria #2, #7.)

### Task 3: Event projection — `antigravity.ts` importer (with in-parser cost)

**Objective**

Importer trio emitting `NormalizedIngestEvent[]` with `agent_type="antigravity"`,
correct token accounting, step→taxonomy mapping, and **cost computed in-parser**.

**Files**

- Create: `src/import/antigravity.ts`
- Create: `tests/antigravity-parse.test.ts`

**Dependencies** Task 2 (cost assertions also depend on Task 4)

**Implementation Steps**

1. Red tests: fixture DB → expected `session_start` + `llm_response` + `tool_use`
   events, one session per DB keyed to the conversation UUID.
2. `discoverAntigravityLogs(dir, {excludePatterns})` globbing `conversations/**/*.db`
   under `~/.gemini/antigravity-cli` (env-overridable).
3. `parseAntigravityFile(filePath, options)`: open DB read-only, iterate `steps` by
   `idx`, decode via Task 2, map `CORTEX_STEP_TYPE_*` → `event_type` (unmapped →
   typed generic, never dropped).
4. Token accounting: store `tokens_in` cache-net (subtract cached), attribute
   thoughts to the agreed lane; compute `cost_usd` **in the parser** via
   `pricingRegistry.calculate` (mirror `src/import/codex.ts:203,220`).
5. `hashFile(filePath)` over raw bytes for `import_state`. Green the tests.

**Verification**

- `pnpm test tests/antigravity-parse.test.ts` passes.

**Done When**

- Parser emits taxonomy-mapped events with cache-net `tokens_in`, thoughts lane, and
  in-parser `cost_usd`. (Criteria #1, #2, #3, #4.)

### Task 4: Model classification + pricing for the *observed* model strings

**Objective**

Make the real recon models — `gemini-pro-default` and `Gemini 3.1 Pro (High)` —
classify to google/gemini and resolve to a priced canonical.

**Files**

- Modify: `src/pricing/model-classification.ts`
- Modify: `src/pricing/data/gemini.json`
- Create: `tests/antigravity-classification.test.ts`

**Dependencies** None (unblocks Task 3's cost assertions)

**Implementation Steps**

1. Red tests for **both** forms: `gemini-pro-default` and the display string
   `Gemini 3.1 Pro (High)`. Note `inferProvider`/`inferFamily` are **case-sensitive**
   (`model-classification.ts:29-43`) and won't match `Gemini …` — so normalization is
   required, not optional.
2. Add display-string normalization (lowercase, strip parenthetical qualifiers like
   `(High)`) and concrete aliases mapping these to `gemini.json` canonicals
   (e.g. `gemini-3.1-pro-preview`), or add priced rows if genuinely missing.
3. Assert an unknown model resolves to pricing-status `unknown` (null cost), never 0
   (`resolve()`→null→`calculate()`→null, `src/pricing/index.ts:136`).

**Verification**

- `pnpm test tests/antigravity-classification.test.ts` passes for both model forms +
  the unknown-model case.

**Done When**

- Observed Antigravity models produce non-zero `cost_usd`; unknowns are honest.
  (Criteria #3.)

### Task 5: Wire into import orchestration

**Objective**

Make `amon import` discover and process Antigravity DBs idempotently.

**Files**

- Modify: `src/import/index.ts`
- Modify: `src/cli/*` import command (`--source antigravity`)
- Create: `tests/antigravity-idempotent.test.ts`

**Dependencies** Task 3

**Implementation Steps**

1. Extend `ImportSource` union with `antigravity`; add `antigravityDir?` to options.
2. **Widen `processFile`'s `source` param** from `'claude-code' | 'codex'`
   (`src/import/index.ts:97`) and thread `antigravityDir` into the `parseFn` call
   (`:121`); add antigravity to the hash/parse selectors and the `runImport`
   discovery loop.
3. Red/green: second import over unchanged DB reports `skippedUnchanged`.

**Verification**

- `pnpm test tests/antigravity-idempotent.test.ts` passes;
  `amon import --source antigravity --dry-run` lists events without writing.

**Done When**

- Re-running import over unchanged DBs is a no-op. (Criteria #5.)

### Task 6: Session projection — browser/search/analytics/trace-quality visibility

**Objective**

Populate `browsing_sessions` (and `messages`/`tool_calls`/`session_items`) so
Antigravity sessions are browsable, searchable, and trace-quality-covered.

**Files**

- Create: `src/parser/antigravity-sessions.ts` (mirror `src/parser/codex-sessions.ts`)
- Modify: `src/watcher/index.ts` (add `syncAllAntigravityFiles`)
- Modify: `src/watcher/service.ts` (startup + periodic resync call; live SSE literals)
- Create: `tests/antigravity-sync.test.ts`

**Dependencies** Task 2

**Implementation Steps**

1. `parseAntigravitySessions(filePath) → ParsedSession` from the shared decoder, with
   `metadata.agent="antigravity"`, messages/tool_calls built from decoded steps.
2. `syncAllAntigravityFiles(db, dir?, opts)` over `conversations/**/*.db`: hash-guard
   via `watched_files`, then `insertParsedSession(db, parsed)`; set
   `browsing_sessions.integration_mode="antigravity-sqlite"` and a `fidelity`
   reflecting decoded richness.
3. Call from startup sync + periodic resync in `service.ts` (leave chokidar
   live-tailing out — deferred follow-on).
4. Red/green: fixture DB yields a `browsing_sessions` row filterable by
   `agent="antigravity"`, with `messages` present so trace-quality/search see it.

**Verification**

- `pnpm test tests/antigravity-sync.test.ts` passes.

**Done When**

- Antigravity sessions are listed and agent-filterable in the browser and visible to
  search/analytics/trace-quality. `coverage_json` honesty is realized in the
  trace-quality projection (reads the populated `messages`/`session_items`).
  (Criteria #6; spec Open Question #3.)

### Task 7: Docs + agent-label surface

**Objective**

Surface the agent everywhere operators look and refresh reference docs; keep the
event `agent_type` and `browsing_sessions.agent` values consistent.

**Files**

- Modify: `src/lib/format.ts` (agent label/color cases, `:54-76`)
- Modify: `docs/system/ARCHITECTURE.md`, `docs/system/FEATURES.md`, `docs/system/OPERATIONS.md`
- Create: `hooks/antigravity/README.md`

**Dependencies** Tasks 5, 6

**Implementation Steps**

1. Add `antigravity` label/color in `format.ts` (filter-options is dynamic via
   `SELECT DISTINCT agent_type` — no change needed there). Ensure both event
   `agent_type` and `browsing_sessions.agent` are `"antigravity"` so the browser
   filter and event rollups don't diverge (cf. existing `claude_code` vs `claude`).
2. Add an Antigravity capability row mirroring the Codex telemetry matrix; document
   `amon import --source antigravity` + any dir/env var.
3. Flip spec + plan `status:` to `in-progress`, then `complete` when shipped.

**Verification**

- `pnpm frontend:check` (if frontend touched); manual `/app/` agent filter shows
  Antigravity.

**Done When**

- Docs match shipped behavior; agent labeled + filterable in `/app/`. (Close-out.)

## Risks And Mitigations

- **Private-proto drift** → descriptor-pinned numbers (Task 1) + fixture guard (Task 2).
- **Cache-inclusive double-bill (~10x)** → enforce `tokens_in` invariant in Task 3 with
  an explicit fixture assertion.
- **Model string doesn't price** (real risk: `Gemini 3.1 Pro (High)` matches nothing) →
  Task 4 normalization + concrete aliases, red-tested for both forms.
- **Two projections drift** (events vs browsing_sessions show different agent/counts) →
  build both from the one decoder; assert agent consistency in Task 7.
- **Concurrent writes to a live DB** → open read-only, tolerate partial rows, skip on
  decode error rather than aborting the run.
- **Fixture leaks transcript text** → scrub in Task 2, keep structural + numeric only.

## Verification Matrix

| Requirement | Proof command | Expected signal |
|---|---|---|
| #1 session-per-DB, UUID-keyed | `pnpm test tests/antigravity-parse.test.ts` | one session per DB, keyed to conversation UUID |
| #2 usage/tokens/thoughts + invariant | `pnpm test tests/antigravity-proto.test.ts tests/antigravity-parse.test.ts` | token buckets match fixture; `tokens_in` cache-net |
| #3 cost via pricing, no silent-zero | `pnpm test tests/antigravity-classification.test.ts tests/antigravity-parse.test.ts` | non-zero `cost_usd` for both model forms; unknown → `unknown` |
| #4 step→taxonomy, no drops | `pnpm test tests/antigravity-parse.test.ts` | unmapped step_type emits typed generic |
| #5 idempotent re-import | `pnpm test tests/antigravity-idempotent.test.ts` | second run reports `skippedUnchanged` |
| #6 browser + search + trace-quality | `pnpm test tests/antigravity-sync.test.ts` | `browsing_sessions` row filterable by `agent`, `messages` populated |
| #7 descriptor-pinned field map | `pnpm test tests/antigravity-proto.test.ts` | decode matches descriptor-pinned baseline |
| Pre-push gate | `pnpm lint && pnpm build && pnpm test` | all green (flat `tests/*.test.ts` names are in the glob) |

## Handoff

- Start at Task 1 (descriptor extraction) — gates criterion #7 and grounds decoding.
- Task 4 has no deps and unblocks Task 3's cost assertions — do it alongside Task 2.
- After Task 3, Tasks 5 and 6 proceed in parallel (distinct files/paths). Note Task 3
  computes cost in-parser, so Task 4 must land first for its cost assertions to pass.
- Resolve spec Open Questions #2–#4 in Tasks 2/3/6 respectively.
