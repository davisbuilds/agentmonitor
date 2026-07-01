---
date: 2026-07-01
topic: antigravity-cli-import
stage: spec
status: draft
source: conversation
---

# Antigravity CLI Import Spec

## Goal

Bring Google-agent activity into AgentMonitor by importing **Antigravity CLI**
sessions, so its runs appear in the session browser, usage/cost rollups, and
trace-quality view alongside Claude and Codex. Deliver **historical import
first**; a live path is a follow-on that reuses the same decoder.

This targets the tool the user actually runs today. Antigravity CLI has
effectively superseded Gemini CLI (both live under `~/.gemini/`): Gemini CLI
transcripts went dormant ~2026-05-04, while Antigravity CLI conversations are
active through late June 2026. Gemini CLI's native-OTEL path (a near-clone of the
Codex OTEL parser) is deferred to a cheap follow-up — it is low current-usage
value.

## Background (verified this session)

Reconnaissance against local artifacts and the shipped `language_server` binary:

- **Source of truth:** `~/.gemini/antigravity-cli/conversations/<uuid>.db` — one
  **SQLite** file per conversation. Tables: `steps`, `gen_metadata`,
  `executor_metadata`, `trajectory_meta`, `trajectory_metadata_blob`,
  `parent_references`, `battle_mode_infos`. `history.jsonl` is only slash-command
  history (not transcripts) and is out of scope.
- **Payloads are plaintext protobuf** — no encryption, no compression, UTF-8
  strings in the clear. A raw wire-format walk recovered: full transcript text
  (system prompt, task spec, agent messages) from `steps.step_payload`; model IDs
  (`gemini-pro-default`, `Gemini 3.1 Pro (High)`) from `gen_metadata`; and token
  usage including a distinct **thinking/thought** bucket.
- **Two schema layers, different stability:**
  - *Usage + model* ride Google's **public, stable** schema —
    `usage_metadata_go_proto.UsageMetadata` /
    `google.cloud.aiplatform.master.UsageMetadata` (incl. `CachedContent.UsageMetadata`,
    `UsageMetadata_BillableUsage`). Field numbers are documented and version-stable;
    cost decoding is low-risk.
  - *Trajectory / Step envelope* is **private** (`exa.cortex_pb`, `exa.eval_pb`,
    `gemini_coder.Trajectory`; note `CascadeStep`/`cascade_id` — Antigravity
    descends from Codeium/Windsurf "Cascade"). Field numbers here are
    version-dependent and must be pinned from embedded descriptors, not guessed.
- **Step taxonomy:** `steps.step_type` is a `CORTEX_STEP_TYPE_*` enum with ~118
  members (observed values 14/15/23/90/98 in a real session). The name list is in
  the binary; exact integer assignments require the embedded `FileDescriptorProto`.

## Scope

**In scope**
- Historical import of `~/.gemini/antigravity-cli/conversations/**/*.db` via the
  existing import + `watched_files` de-dupe template (`src/import/`, `src/watcher/`).
- A new `src/import/antigravity.ts` parser: open each conversation DB read-only,
  decode step/usage/gen protobuf, emit normalized events on the standard contract.
- Cost + usage attribution using the existing pricing engine and
  `src/pricing/data/gemini.json`.
- Session-browser + usage/analytics + trace-quality visibility for Antigravity
  sessions, at whatever coverage honesty the decoded data supports.

**Out of scope (this spec)**
- Live tailing of active `.db` files (follow-on; same decoder, re-read on change).
- Gemini CLI OTEL/import path (separate, deferred).
- Antigravity **IDE** (`~/.antigravity/`, an Electron/VS Code fork) — different
  ingestion entirely.
- Provider-quota header integration for the Monitor (needs a live source Antigravity
  may not expose).

## End State & Success Criteria (falsifiable)

1. Running the importer over a populated `~/.gemini/antigravity-cli/conversations/`
   directory produces `sessions` + `events` rows with `agent_type` set to the
   agreed Antigravity identity (see Open Questions §1), one session per conversation
   DB, keyed stably to the conversation UUID.
2. Each imported LLM response event carries model ID and token counts decoded from
   `UsageMetadata`, with `tokens_in` stored per the repo's **cache-inclusive
   invariant** (cached subtracted before store; thinking/thought tokens attributed
   to the correct lane) — verified by a fixture DB with known counts.
3. `cost_usd` is computed for imported events via the pricing registry against
   `gemini.json`, with resolvable model IDs (unresolved models surface as
   pricing-status "unknown", never silently zero-cost).
4. Step events map onto the existing event taxonomy (prompt / llm_request /
   llm_response / tool_use / lifecycle) via a documented `CORTEX_STEP_TYPE_*`
   mapping; unmapped step types are ingested as a typed generic rather than dropped.
5. Re-running import over unchanged DBs is a no-op (hash-based `watched_files`
   de-dupe), matching Claude/Codex importer behavior.
6. Imported Antigravity sessions render in the Svelte `/app/` session browser and
   are filterable by agent, and contribute to usage/cost rollups with correct
   coverage-honesty flags (summary vs full fidelity).
7. Decoding is anchored to **pinned field numbers** extracted from the binary's
   embedded proto descriptors (not the reverse-engineered numbers from recon), with
   a fixture-based test guarding against silent schema drift.

## Decisions

- **Agent identity string (settled).** `agent_type = "antigravity"` (the tool),
  with models classified provider `google` / family `gemini` in
  `model-classification.ts` — parallel to `codex` running `gpt-*`. This is a stable
  contract value; downstream filters, colors, and rollups key off it.

## Open Questions (resolve during planning)

1. **Field-map extraction method.** Extract `exa.cortex_pb` / `gemini_coder`
   `FileDescriptorProto` from the Go `language_server` binary (rawDesc) to get
   authoritative field numbers + the `CORTEX_STEP_TYPE_*` integer map. Fallback:
   the self-consistent reverse-engineered map from recon, guarded by fixtures.
2. **Usage field semantics.** Confirm prompt-vs-cached-vs-candidate-vs-thought
   field layout against `UsageMetadata`, and whether Antigravity's prompt count is
   cache-inclusive (the ~10x double-bill trap the pricing engine already handles
   for OpenAI/Google).
3. **Coverage honesty.** Decide which `coverage_json` flags Antigravity import sets
   (it is richer than Codex OTEL summary but may lack some transcript structure).
4. **WAL/read-safety.** Open conversation DBs read-only and tolerate concurrent
   writes from a running Antigravity session even in the historical path.

## Evaluation

- Unit: fixture conversation DB(s) with known model + token counts → asserts on
  decoded events, `tokens_in` invariant, thought-token lane, and `cost_usd`.
- Integration: import a copied real `.db`, assert session/event row shape,
  idempotent re-import, and taxonomy coverage of observed step types.
- Manual: imported Antigravity sessions visible and filterable in `/app/`, with
  usage/cost rollups reconciling against the decoded totals.

## Follow-ons (not this spec)

- Live Antigravity path: chokidar on `conversations/*.db`, re-decode on write,
  reconcile with historical import like Codex live/import overlap.
- Gemini CLI OTEL + chat-import (deferred; cheap clone of Codex path).
- Antigravity provider-quota source for the Monitor header, if one exists.
