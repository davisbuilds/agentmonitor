---
date: 2026-11-25
author: Codex
topic: antigravity-parity
stage: spec
status: draft
source: read-only-local-investigation
risk_profile: routine
readiness: draft
---

# Antigravity Parity Investigation and Design Spec

## Problem

AgentMonitor discovers Antigravity CLI SQLite data, imports usage and projects
session summaries. On the sampled MacBook, the current CLI also persists
transcript and tool evidence that the adapter discards. The existing billing
decoder adds a model enum to uncached input tokens. The separate legacy IDE
history has a different, still opaque conversation format. These findings
qualify both the Mac mini observation of no local capture and the CLI
integration guide's claim of exact cost. [Parity backlog](../project/BACKLOG.md#antigravity-parity-with-claude-and-codex) · [Integration guide](../../hooks/antigravity/README.md)

## Scope

One macOS arm64 MacBook observed on November 25, 2026 local time, with `agy
--version` reporting **1.5.17**, the Antigravity agent app **2.0.11**, and the
separate Antigravity IDE **2.1.1**. The installed AgentMonitor store and source at
`bcd79e0` are distinct evidence. This document proposes changes to CLI and IDE
discovery, local projection, and usage coverage. Product implementation, data
repair, and plan economics are follow-up work.

## Local storage inventory

Filesystem counts are regular files. Filesystem dates are local modification
dates. Record ranges use UTC unless marked local. Counts from separate reads
can differ because the CLI and AgentMonitor were active. The SQLite reads used
`mode=ro`, query-only mode and memory temporary storage. Reads of live WAL data
used existing sidecars. No imports or controlled provider sessions were run.
Here and below paths use portable home-relative names, and measurements contain
only aggregate or structural data. Inventory can be repeated by grouping
regular files by suffix and comparing modification ranges, then querying
`sqlite_schema`, `steps`, `gen_metadata` and `conversation_summaries` for
counts, nullable fields and index joins. For AgentMonitor, the aggregate
controls are `events`, `browsing_sessions`, `messages`, `session_items`,
the trace summary and quota snapshots. Compare counts within a read
transaction where possible.

| Location | Format, counts and dates | Meaning and freshness |
| --- | --- | --- |
| `~/.gemini/antigravity-cli/conversations/` | 69 SQLite DBs, with 69 WAL and 69 SHM files in the initial inventory. File modifications June 22–November 25. 67 contained steps and 2 were empty. Initial read found 2,100 steps and 568 generations, with step creation June 22–November 26 UTC. | DB basename joins the conversation summary and transcript directory. `idx` is a local row index. WAL and step counts advanced during observation. The median nonnegative interval between consecutive observed step timestamps within a conversation was 1 s across 2,033 pairs. This describes the workload. Flush and checkpoint intervals remain unmeasured. |
| `~/.gemini/antigravity-cli/conversation_summaries.db` | One SQLite DB plus WAL/SHM, last written November 25 local. 82 summaries, 167 FTS chunks and an empty `conversation_parents` table. Non-sentinel summary modification dates January 24–November 26 UTC. | 69 matched CLI DBs, 13 had no matching CLI DB. 3 had a title, 76 a preview, 40 a nonempty workspace list, 69 a nonempty `raw_summary`, and 4 named a parent present in the index. Summary and WAL advanced during the live session. |
| `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/` | 67 each of `transcript.jsonl` and `transcript_full.jsonl`, June 22–November 25. Each set had 2,095 parseable records in a first scan. 142 numbered JSONL chunks under `chunks/{transcript,transcript_full}/`, August 11–November 25, include overlapping steps and some unparsable lines. | The bounded variant marks `truncated_fields`; the full variant contains more content. In a later scan, all 2,099 full-log records matched a step by conversation, index and timestamp second. These mirrors grew during the observation. No append-only or chunk completeness guarantee was established. |
| `~/.gemini/antigravity-cli/brain/<id>/.system_generated/steps/` and other brain files | 984 files across `brain/` in the initial count, June 22–November 25. More than 550 step `output.txt` files, plus JSON, task logs and Markdown. | Step files are local output spill and artifacts. The descriptor exposes `full_output_uri`, but blanket directory traversal would also collect artifacts, task logs and repository material. |
| CLI ancillary files | 13 `implicit/*.pb` June 22–November 25, 3 `annotations/*.pbtxt` September 23–November 23, 1 `jetbox_summaries_proto.pb` and 1 `history.jsonl` written November 25. The latter held 44 rows. 46 files in `builtin/`, September 26–November 23, including 16 `SKILL.md` files. | History records `display`, `timestamp`, `workspace` and optional `conversationId` and `type`, including slash and shell commands. Bundled skills are a catalog. Transcript tool args mentioned `SKILL.md` 29 times in a later scan, which is candidate read evidence. |
| `~/.gemini/antigravity/` | 13 `conversations/*.pb` all modified May 20, 13 `annotations/*.pbtxt` January 24–February 3, 167 `brain/` files January 24–25, 83 `implicit/*.pb` January 17–May 11. One summary protobuf dated May 20 and a state textproto dated June 6. | Legacy app history and artifacts. The conversation blobs failed a plain protobuf wire parse and lacked a gzip header. The artifact set includes Markdown, JSON and revisions. No recent trajectory write or usable step, model, usage, skill-read or subagent map was verified for this layout. |
| `~/.gemini/antigravity-ide/` and `~/.gemini/antigravity-backup/` | Each has 13 conversation blobs, 13 annotations, 167 brain files and 83 implicit blobs with May 20 file dates. IDE also has nine plugin files dated July 23. The two sets of 13 conversation blobs are byte-identical to each other. The parallel original app blobs are each 21 bytes larger. | Treat these copies and the 13 summary-only entries as a migration/deduplication question. The storage copies do not establish how the current IDE writes a new session. Both IDE and old app skill directories were empty in this sample. |
| `~/.antigravity*/`, macOS Application Support and browser profile | Extension trees of 9,386 and 2,872 files, January–May and June–July respectively, plus launch settings. Under `~/Library/Application Support/{Antigravity,Antigravity IDE}/User/`, 668 and 10 files respectively, including 26 and 3 editor `.vscdb` files, editor history, and JSON. IDE user files last changed July 24. Chromium profile/storage includes LevelDB, SQLite and cache files. | These are extension, editor or browser support surfaces. No alternate trajectory decoder was validated here. Browser credentials, account state and network caches are outside the evidence boundary. |

### CLI fields with corroboration

- **Session and lineage.** `conversation_summaries` has a primary
  `conversation_id`, `title`, `preview`, `step_count`, JSON
  `workspace_uris` where supplied, and `last_modified_time`.
  `last_user_input_time` and `last_user_input_step_index` identify the most
  recent indexed prompt. `parent_conversation_id`, `nesting_depth` and
  `agent_name` were populated for four child rows with matching DBs.
  `status`, `not_fully_idle` and `killed` are run state, and
  `app_data_dir` identifies the source root. `project_id`, `source`,
  `group_id` and the battle fields exist. Their broader semantics remain
  unvalidated. FTS records text chunks and step bounds. Its count measures
  index chunks. `raw_summary` is a BLOB, whose contents were not needed.
- **Steps and tools.** `trajectory_meta` maps trajectory and cascade IDs
  and tags type/source. `steps` stores a complete plaintext `Step`
  protobuf in `step_payload`, with `step_format=0` throughout the initial
  scan. Envelope fields 1 and 4 matched indexed type and status for all
  2,100 rows. Use the oneof tag for kind. The per-row `metadata` carries
  creation time at `1 → 1`. Permissions, error details and task details
  also have decomposed columns. `executor_metadata` had 129 rows and
  `trajectory_metadata_blob` one row per DB. `parent_references`,
  `battle_mode_infos` and nested trajectory flags were empty.
- **Transcript and outcomes.** JSONL records expose `step_index`,
  `created_at`, `source`, `type`, `status`, `content`, optional
  `thinking`/`error`, and planner `tool_calls[].{name,args}`. The first
  scan had 1,102 calls and 1,083 generic steps. The protobuf generic step
  (oneof 140) has repeated args (1) and result (2). The recovered result
  descriptor defines text, typed payloads, render information and output
  URI. A later scan found result text and typed payloads in over 1,000 rows
  and output URIs in over 550. Its optional standardized call/result
  fields (8/9) were absent in that scan. JSONL has no call ID on its tool
  call objects. Planner protobuf field 7 and step metadata field 4 expose
  `ChatToolCall`, whose descriptor includes ID, name and arguments. Check
  stored ID coverage before enabling call/result joins. Four JSONL calls named `invoke_subagent`. Join child IDs
  through explicit evidence only. The typed `CortexStepInvokeSubagent`
  also has result conversation IDs, but the initial rows had no instance
  of that oneof.
- **Usage.** `gen_metadata(idx,data,size)` stores a
  `CortexStepGeneratorMetadata` protobuf. The wrapper's `chat_model` (1)
  contains `ChatModelMetadata`, with `usage` (4), `response_model` (19)
  and display name (21). CLI also defines full model (22). The model and
  usage paths decoded in all 568 initial rows. All 568 satisfied
  output = thinking + answer, and 493 carried nonzero cache reads.
  Dominant response IDs included `gemini-4-hydrogen-tiered-xhigh` and
  `gemini-4-neon`. JSONL exposes planner input, output and cache-read
  counters, model and timestamp. In a later 572-generation scan, exact
  session/model/output/cache matching found 351 unique JSONL candidates
  when JSONL input equaled usage field 2. Only 12 matched when cache reads
  were added, and none matched when the enum was added. This is a
  cross-check with a partial match rate. Treat SQLite generations as the
  usage source, and verify the association before using JSONL time for any
  particular generation. Neither `idx` nor `idx+1` is a reliable step
  join across the sample. A later ID check found that all 511 populated
  usage `message_id` values matched a planner `message_id` within their
  conversation. All 508 populated usage `provider_assigned_message_id`
  values matched their planner counterpart. These are better candidates for
  timestamp recovery. Require a unique match and test their behavior across
  retries and subagent turns.
- **Timing and context.** `chat_start_metadata.created_at` at `9 → 4`
  remains the correct descriptor path, but resolved for only 71 of 568
  initial generations, all June 22–August 14 UTC. Those 71 matched a
  planner step second. In a later 575-row scan, duration fields
  `time_to_first_token` (11) and `streaming_duration` (12) were present
  throughout. Nested `context_window_metadata` (9 → 10) contained
  `estimated_tokens_used` (1) in all 575 and `max_context_tokens` (4) in
  554. Validate the observed context values and units before promotion.
  Missing start time currently falls back to the session's first step,
  which can misplace usage in a window or price epoch.

### Field-map regeneration

The [baseline procedure](baselines/antigravity-proto-fieldmap.md#regenerating)
was run with the cached `protodump` source at commit `3bb63dd07101`. The
extraction read the agent app's `Contents/Resources/bin/language_server`, the
IDE's `Contents/Resources/bin/language_server_macos_arm` and the executable
returned by `command -v agy`. Run `protodump -file "$binary" -output
"$worktree_scratch/protos"` for each, into separate worktree directories. Stock
extraction recovered 76, 114 and 111 descriptors respectively. For the desktop
binaries the pinned envelope, all 120 known oneofs and the six public
`UsageMetadata` fields match. The CLI stock scanner missed the target
descriptors. A targeted check found the serialized `FileDescriptorProto` by
matching field 1's length-delimited full filename, walking valid descriptor
fields and unmarshalling as `descriptorpb.FileDescriptorProto`. Require a unique
encoded filename match, stop on an invalid wire field or repeated singleton,
then verify the filename, package and target message names. Compare the
desktop results to stock output as a positive control. The targeted check recovered `trajectory.proto`,
`usage_metadata.proto` and the private `cortex.proto` from the CLI binary.
The CLI retains the 120 known oneofs and adds `directory_rules=156` and
`tool_search=157`, plus envelope fields `custom_extensions=158` and
`generic_step=159`. The pinned field numbers still identify existing steps.
The taxonomy and claims about available descriptors need revision.

For billing, the linked `ModelUsageStats` descriptor defines usage field 1
as a **model enum**, including placeholder values 1016 and 1020 used as the
baseline's evidence for system prompt tokens. It defines field 2 as
`input_tokens`, 3 as `output_tokens`, 4 as `cache_write_tokens`, 5 as
`cache_read_tokens`, 9 as `thinking_output_tokens` and 10 as
`response_output_tokens`. The legacy sum `field1 + field2` is therefore
wrong. The old public `UsageMetadata` map concerns a different message. In
a later 575-row check, the importer formula would add 844,046 enum units to
the native input counters. `ChatModelMetadata` also defines `model_cost`,
`credit_cost` and `consumed_credits`, but none was present in those 575
records. Descriptor presence alone supplies neither a price nor a quota
conversion. [Shipped map](../../src/import/antigravity/fieldmap.ts) · [Shipped decoder](../../src/import/antigravity/proto.ts)

## AgentMonitor capture today

The installed MacBook store had 67 Antigravity event sessions and the same 67
browser identities. Of 2,680 events, all were imported, with 556 LLM usage
events, 90 prompts, 14 tool calls and 6 errors. Event dates spanned June
22–November 25 local. The 556 usage rows held 9,826,912 input tokens as
currently normalized, 122,391,485 cache-read tokens, and 817,712 output
tokens, including 504,215 thinking tokens. All 556 had an estimated cost,
summing to $38.939901. Recomputing those rows with the current rate table and
stored event dates matched every estimate within $0.00000001. That
cross-check proves the calculation on stored inputs. The enum and timestamp
findings invalidate it as a check of source accounting. There was no
provider-reported cost, cache-write count above zero, or recorded duration
in those rows. [Importer](../../src/import/antigravity.ts) · [Session total checker](../../src/import/session-total-check.ts)

All 67 browser rows had `antigravity-sqlite` summary fidelity and trace
summaries. One transactional snapshot had 2,106 projected items and messages,
including 90 user labels and 14 named tools. Those tools had no persisted
arguments, results or call IDs. The browser projection had advanced 49 steps
beyond imported step events in one active conversation. There were 18
project values, 25 working directories, 3 titles and 4 parent links. All 67
had the same 1,048,576-token context denominator. The bridge had one
available Antigravity quota snapshot with both windows and two historical
percentage samples. [Session parser](../../src/parser/antigravity-sessions.ts) · [Live adapter](../../src/live/antigravity-adapter.ts) · [Quota receiver](../../src/api/provider-quotas.ts)

The runtime separately schedules event import, normally every ten minutes.
Its Antigravity change detector hashes the main DB. WAL-only changes can
advance the watcher, which checks DB/WAL/SHM and summary state, before the
importer rereads usage. The observed lag is consistent with that mechanism.
The comparison does not isolate its cause. A force import still encounters
event deduplication. The statusline bridge updates presence, quota and context
and can attach a watcher. It emits no billing events. [Import dispatch](../../src/import/index.ts) · [Watcher](../../src/watcher/index.ts) · [Runtime](../../src/runtime.ts)

## Gap matrix

The Antigravity column describes current AgentMonitor behavior and evidence
from this installation. A partial surface delivers some of its contract.
Missing indicates evidence the product does not expose. Impossible-from-local-data
is scoped to a measurement absent from the inspected stores.

| Surface | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Historical import | Per-project JSONL with event and transcript paths. | Rollout JSONL or compressed rollout. Default discovery excludes archived sessions. | **Partial.** Per-conversation CLI SQLite imports events and generations. IDE blobs and CLI transcript mirrors are outside discovery. [Importer](../../src/import/antigravity.ts) |
| Live capture | Hooks supply lifecycle and activity, with JSONL watcher for transcript. | OTLP plus rollout watcher. OTLP alone lacks transcript. | **Partial.** WAL watcher projects browser/live summaries. Statusline supplies presence and periodic import supplies events. No immediate event-backed usage updates. [Watcher](../../src/watcher/index.ts) |
| Session list and detail | Shared list/detail/search with transcript and project evidence. | Shared list/detail/search with rollout aliases and telemetry-only coverage. | **Partial.** 67 browseable summaries with some project, title and parent fields. Search indexes synthetic labels. [Parser](../../src/parser/antigravity-sessions.ts) |
| Turns and items | JSONL messages, tool activity and results in projected turns. | Rollout text, linked tool receipts and projected turns. | **Partial.** Adapter synthesizes completed turns from individual steps. Prompt boundaries, responses, error detail and actual text are unexposed. [Adapter](../../src/live/antigravity-adapter.ts) |
| Tools | Typed call args/results with outcome where recorded. | Telemetry outcomes and rollout call-linked receipts, with coverage limits. | **Partial.** 14 projected tool names. More than 1,000 generic execution steps are classified as general responses. Arguments, results, durations and outcomes need source-backed projection. [Step classification](../../src/import/antigravity.ts) |
| Skills | Explicit skill calls or instruction events. | Concrete skill-file reads with telemetry/rollout dedupe. | **Missing.** Ledger and session context lack Antigravity. Native logs expose candidate skill-file reads. [Skill ledger](../../src/skills/invocation-ledger.ts) |
| Models | Transcript billing model. | OTLP or turn context with attribution provenance. | **Partial.** Historical usage keeps native response model and uses Gemini aliases. The browser lacks reliable per-item model attribution on mixed-model sessions. [Decoder](../../src/import/antigravity/proto.ts) |
| Usage and cost | Distinct billing buckets with native session comparison where available. | Usage requests or cumulative deltas with overlap handling and native comparison. | **Partial.** Imported estimates exist, with inflated input and potentially misplaced dates. Native billed spend and exact plan debit are **impossible-from-local-data** in the inspected records. [Billing decoder](../../src/import/antigravity/proto.ts) |
| Quota | Statusline rate-limit samples. | Native app-server polling for rate limits and plan where available. | **Captured.** Configured statusline bridge stored both windows and historical samples. It selects Gemini windows with a third-party fallback. Quota deltas have no request attribution. [Quota receiver](../../src/api/provider-quotas.ts) |
| Parent/child links | Child transcript and tool session IDs. | Native thread-spawn metadata and internal-thread distinction. | **Partial.** Four indexed parent links project. Call-to-child attribution and child role/timing need evidence. [Summary decoder](../../src/import/antigravity/summary.ts) |
| Git view | Repository discovery and attribution from call/result proof. | Repository discovery and attribution including supported asynchronous receipts. | **Partial.** Cwd can locate a repository. Synthetic Git/activity labels lack the proof required to assign a commit or PR to a session. [Git queries](../../src/db/v2-queries.ts) |
| Overview analytics | Shared activity and usage, with observed tools and token coverage. | Shared analytics with coverage limits for telemetry-only sessions. | **Partial.** Import and summary activity can contribute. Synthetic labels can qualify as transcript availability, while missing outcomes or compaction evidence leave incomplete denominators. [Overview queries](../../src/db/v2-queries.ts) |
| Warehouse export | Shared content-free session summaries. | Same, with identity dedupe. | **Partial.** Antigravity usage and trace summary can export through the shared path. The current export omits coverage details that distinguish unobserved usage from zero. [Export source](../../src/warehouse/source.ts) |

Claude and Codex reference behavior comes from the repository's
[operations guide](../system/OPERATIONS.md), [feature map](../system/FEATURES.md),
[trace quality contract](../system/trace-quality.md) and
[architecture](../system/ARCHITECTURE.md).

## Contract

A supported local CLI conversation should resolve to one identity across
history, Live, Usage and export. The CLI SQLite generation row owns measured
usage. Explicit source evidence owns each timestamp, parent link, tool receipt
and skill read. The richer local representation should reach the v2
projection, with its limits visible in filters and aggregates. Preserve
summary fallback for older and incomplete sessions. Use
`pnpm test:v2:contract:ts` and a fixture-backed built-browser scenario to
verify the same CLI identity and fidelity across list, detail, Live and Usage.

## Success Criteria

- A fixture with two generations, different models and cache buckets, on
  opposite sides of a pricing/window boundary yields the expected per-model
  totals. An enum value never enters arithmetic, thinking is counted once,
  and unknown time/price shows as unavailable.
- An update written to WAL reaches both projections while the main DB hash is
  unchanged. Reread, restart and forced reconciliation converge to the same
  generations, steps and aggregate totals.
- A user turn with two same-named calls, one failed result and a distinct
  child session yields the evidenced count, outcome and link. An unlinked
  receipt and a file mention leave no fabricated result or skill read.
- Summary-only legacy sessions remain browsable with accurate coverage.
  A usage-only row never implies transcript availability. A trace export
  carries token and cost coverage without exporting conversation content.

## Ordered implementation slices

1. **Pin the evidence and fix accounting.** Update the baseline and synthetic
   fixture map to reflect the recovered descriptors. Decode input from field
   2, cache write/read from 4/5, inclusive output from 3 and thinking from 9.
   Test red/green with a nonzero enum, cache hit, cold request, output split,
   optional modalities and missing fields. Test exact native message-ID joins
   with a duplicate-ID refusal and the legacy timestamp path. Prefer recorded
   generation time, then a uniquely joined planner timestamp with provenance.
   Keep unattributed time out of quota windows. Verify any separately stored
   context estimate and native denominator before replacing the fallback.
2. **Reconcile historical and live CLI readers.** Share a read-only SQLite
   snapshot reader for import and watcher. Track meaningful WAL changes and
   changed summary/mirror records, with fast skips and bounded retries for WAL
   churn, locked reads and partial JSONL. Keep a stable conversation key and
   generation identity and reconcile the old ordinal event IDs before replacing
   previously normalized rows. Make corrections and their dependent summaries
   atomic in AgentMonitor. Provide a preview and explicit repair path for old
   usage. Test checkpoint, restart, reordered rows, retry, force,
   preexisting duplicate candidates and interruption in a disposable database.
3. **Project real turns and tools.** Join synthetic JSONL and SQLite fixtures
   by conversation, step and timestamp. Start with bounded transcript content,
   native user/assistant text, tool names and explicitly correlated receipts.
   Prefer native call IDs wherever present and use an unpaired state otherwise.
   Test truncated mirror lines, missing/mismatched indices, generic result
   errors, replayed records and output size limits. Exercise v2 session detail,
   search and Live against a compiled disposable server. Reuse existing local
   privacy and output-preview limits before enabling richer text. Avoid
   arbitrary output URI reads and all artifact traversal.
4. **Add skill, child and Git evidence.** Emit skill consultations for verified
   reads under recognized skill roots, using the existing ledger's dedupe.
   Attach child IDs from summaries or explicit result fields and enable Git
   attribution through the existing proof rules. Test repeated skill reads,
   a mere path mention, two children, missing parent, ambiguous receipts and
   a Git command without a confirming result. Reuse the same identity in
   the Overview and warehouse checks.
5. **Expose coverage and price comparisons.** Reuse the dated Gemini registry
   and estimated cost provenance. Unknown rates preserve token counts and
   remain unpriced. Rebuild derived summaries after any correction. Add
   explicit coverage for approximate time, missing outcomes and observed
   versus unavailable usage in v2 and export. Test all-zero measured usage,
   missing data, one unknown model and a mixed-source export under the
   existing privacy contract.
6. **Investigate IDE parity as an independent slice.** Establish the current
   IDE's writer and a supported local export or format using a disposable
   session and version-matched evidence. Compare the resulting artifacts to
   the 13 legacy entries and exercise both dedupe and explicit summary-only
   fallback. Fixture-test discovery and decode before enabling it. An IDE
   decoder should remain gated while framing and ownership are unresolved.
7. **Validate the plan comparison separately.** Add Antigravity only after
   corrected usage and time coverage are visible. Test five-hour and weekly
   reset alignment with two models sharing a pool, an intervening plan
   change, an unobserved interval, and a merged outcome with incomplete
   attribution. The report should show observed yield with uncertainty
   and preserve an unknown plan cohort.

## Evaluation

Use generated fixtures with independent expected counts rather than copied
sessions. Start each SQLite/JSONL case with a positive decode control, then
cover corrupted or unknown wire fields, partial mirror writes and unreadable
sidecars. Cover recent CLI, older CLI, summary-only and mixed-model sessions
in the built app. Use disposable stores for import and correction tests.
Compare usage buckets to independent native fields before comparing USD to
the dated registry. Use a synthetic red/green case where the old result
differs numerically and a second case where the wrong time moves an event
between windows.

## Assumptions And Constraints

The CLI renders from local evidence that can be incomplete or updated
asynchronously. Use read-only producer files, local normalized storage and v2
paths. Preserve the warehouse's content-free scope. Prices in the registry
express API equivalence. Plan fees, quota consumption and actual charges
are separate quantities.

For the [harness, model and plan comparison](../project/BACKLOG.md#harness-model-and-plan-cost-comparison),
group corrected requests by harness, canonical model and observed window
scope. Join consecutive quota samples by account, bucket and reset time,
and record interval coverage, gaps and resets. Report observed tokens and
API-equivalent estimates inside the reset window. Shared pools, other devices,
partial intervals and meter/model-weight changes prevent assigning every
sample delta to a particular request. Keep Gemini and third-party pools
distinct, and attach a plan cohort only when observed independently. Treat
cost per merged outcome as shared Git-attributed API equivalence with
unattributed activity visible. Cost per task requires explicit task boundaries
or a documented grouping rule. Quota percent alone provides neither the
subscription's dollar cost nor the provider's debit formula.

## Open Questions

- **Current IDE.** Legacy blobs failed end-to-end protobuf, common compression
  signatures, and whole-file length framing checks. Both desktop server
  binaries contain trajectory saver encryption-key symbols, consistent with
  opaque persistence. A supported format/export
  or a controlled IDE run with before/after observation would settle the
  current writer and usable fields. The existing copies cannot establish
  either fact.
- **Generation and result joins.** The observed same-conversation native
  message-ID matches are promising. A controlled CLI fixture with retries,
  child work, parallel calls, errors and rewritten steps would establish
  uniqueness, lifecycle and result binding. An isolated fixture with native
  usage output would help settle the residual JSONL/SQLite counter mismatch.
- **Accounting.** No populated native cost, credit or billing fields were
  found in the sampled generations. An official export or documented billing
  and quota semantics would be needed for actual charges, plan debits, shared
  pool attribution and a native independent session-total check. The
  investigation stopped at local evidence and did not access Google services.
