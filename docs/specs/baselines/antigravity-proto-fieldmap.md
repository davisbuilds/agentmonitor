---
date: 2026-11-27
topic: antigravity-cli-import
stage: baseline
status: reference
source: binary-extraction
---

# Antigravity Proto Field Map (Baseline)

Authoritative field numbers for decoding Antigravity CLI conversation databases
(`~/.gemini/antigravity-cli/conversations/<uuid>.db`). This baseline pins the
descriptors used by the shipped importer so they are not reverse-engineered at runtime.

## Provenance

Extracted from both the Antigravity desktop `language_server` binary
(`/Applications/Antigravity.app/Contents/Resources/bin/language_server`, arm64) using
[`protodump`](https://github.com/arkadiyt/protodump) and the Antigravity CLI `agy`
binary (`command -v agy`, arm64) by scanning embedded serialized `FileDescriptorProto`
records:

```bash
go install github.com/arkadiyt/protodump/cmd/protodump@latest
protodump -file "/Applications/Antigravity.app/Contents/Resources/bin/language_server" -output ./protos
# Key files recovered across language_server and agy:
#   third_party/gemini_coder/proto/trajectory.proto          (Step envelope + taxonomy)
#   third_party/jetski/cortex_pb/cortex.proto                (ChatModelMetadata, ChatStartMetadata, ContextWindowMetadata, CortexStepPlannerResponse)
#   third_party/jetski/codeium_common_pb/codeium_common.proto (ModelUsageStats)
#   google/cloud/aiplatform/master/usage_metadata.proto      (Google UsageMetadata)
```

The typed subset consumed by the importer lives in `src/import/antigravity/fieldmap.ts`
(unused exported constants trip `tests/codebase/dead-code.test.ts`).

## SQLite → proto mapping

Each conversation `.db` has a `steps` table. Some columns mirror `gemini_coder.Step`
fields for indexing (`step_type` = `Step.type`, `status`, etc.), but **`step_payload`
is the FULL serialized `gemini_coder.Step` message** — not just the oneof payload.
Verified against real rows: a `step_payload` decodes to top-level fields
`{1: type, 4: status, 5: metadata, <oneof-field>: payload}`, where field 1 equals the
`step_type` column. So the decoder reads `step_payload` as the whole envelope; the
decomposed columns are redundant with fields already inside it. `steps.metadata`
(`CortexStepMetadata`) carries `created_at` at field `1` (`google.protobuf.Timestamp`
`{ seconds: 1, nanos: 2 }`). `gen_metadata` holds the per-generation record.

## Real token accounting — `CortexStepGeneratorMetadata` & `ModelUsageStats` (descriptor-pinned)

The Google `UsageMetadata` schema (below) is not the persisted per-generation billing
record in Antigravity CLI databases. The persisted usage lives inside
`gen_metadata.data` → field **1** (`ChatModelMetadata`, `oneof metadata` on
`exa.cortex_pb.CortexStepGeneratorMetadata`):

- `ChatModelMetadata.usage` (field **4**): `.exa.codeium_common_pb.ModelUsageStats`
- `ChatModelMetadata.chat_start_metadata` (field **9**): `.exa.cortex_pb.ChatStartMetadata`
- `ChatModelMetadata.response_model` (field **19**), `model_display_name` (field **21**), `response_model_full` (field **22**)

| `ModelUsageStats` field (`gen_metadata` `1 → 4`) | # | Type / Meaning |
|---|---|---|
| `model` | 1 | `.exa.codeium_common_pb.Model` enum (e.g. `1016`, `1020`, `1071`, `1318`, `1531`, `1532`) — non-billing metadata, **never** added to `tokens_in` or `context_used_tokens` |
| `input_tokens` | 2 | `uint64` — uncached full-rate input tokens |
| `output_tokens` | 3 | `uint64` — total output tokens (inclusive of thinking; `3 === 9 + 10` verified across all 853 local records) |
| `cache_write_tokens` | 4 | `uint64` — cache-creation tokens |
| `cache_read_tokens` | 5 | `uint64` — cached input tokens (additive, non-overlapping with `input_tokens`) |
| `message_id` | 7 | `string` — native message ID matching `CortexStepPlannerResponse.message_id` (`20 → 6`) |
| `thinking_output_tokens` | 9 | `uint64` — reasoning subset of `output_tokens` |
| `response_output_tokens` | 10 | `uint64` — answer subset of `output_tokens` |
| `provider_assigned_message_id` | 12 | `string` — provider response ID matching `CortexStepPlannerResponse.provider_assigned_message_id` (`20 → 15`) |

**Billing (`deriveBillingTokens`):** `tokensIn = inputTokens` (field 2 only),
`tokensOut = outputTokens` (field 3, inclusive of thinking),
`cacheWriteTokens = cacheWriteTokens` (field 4),
`cacheReadTokens = cacheReadTokens` (field 5), and
`thoughtsTokens = thinkingTokens` (field 9, informational lane).
`antigravity-sessions.ts` computes prompt context occupancy from `tokensIn + cacheReadTokens + cacheWriteTokens` (never `modelEnum`).

### Generation timestamp recovery & provenance

Each generation in `gen_metadata` resolves its timestamp in strict priority order:
1. `ChatStartMetadata.created_at` (`9 → 4`, `google.protobuf.Timestamp`) → `timestamp_source: 'generation_created_at'` (present in 71/853 local records, June–August 2026).
2. Unique match on `ModelUsageStats.message_id` (`4 → 7`) against `CortexStepPlannerResponse.message_id` (`step_payload` oneof `20 → 6`) in the same conversation → `timestamp_source: 'planner_message_id'` (782/853 local records; duplicate matches refused).
3. Unique match on `ModelUsageStats.provider_assigned_message_id` (`4 → 12`) against `CortexStepPlannerResponse.provider_assigned_message_id` (`step_payload` oneof `20 → 15`) in the same conversation → `timestamp_source: 'planner_provider_message_id'` (duplicate matches refused).
4. Unattributed → `client_timestamp: undefined`, `timestamp_source: 'unavailable'` (never falls back to the session's first step timestamp).

### `ContextWindowMetadata` validation (`9 → 10`)

`ChatStartMetadata.context_window_metadata` (field **10**) carries
`estimated_tokens_used` (field **1**) and `max_context_tokens` (field **4**).
Local corpus validation across 825 generations confirmed neither should replace the
shipped occupancy numerator or denominator:
- `estimated_tokens_used` is a pre-request heuristic (163 vs 18,241 actual prompt tokens on older `gemini-3.6-flash` turns; ~5k–7k above actual on Gemini 4 turns). Actual prompt occupancy comes from `input_tokens + cache_read_tokens + cache_write_tokens`.
- `max_context_tokens` holds CLI truncation budgets (`128,000` for `gemini-pro-default`, `256,000` for `gemini-3.6-flash` / `3.8-flash`, `512,000` for `gemini-4-neon` / `gemini-4-hydrogen`), whereas the `agy` statusline bridge reports the underlying `1,048,576`-token model window (`ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW`).

## Pinned: token usage schema — `google.cloud.aiplatform.master.UsageMetadata`

Authoritative public schema (not the persisted per-turn billing source in CLI DBs; kept for `decodeGoogleUsage`):

| Field | # |
|---|---|
| `prompt_token_count` | 1 |
| `candidates_token_count` | 2 |
| `total_token_count` | 3 |
| `cached_content_token_count` | 5 |
| `tool_use_prompt_token_count` | 13 |
| `thoughts_token_count` | 14 |

**Cache-inclusive invariant:** `prompt_token_count` *includes* cached tokens. Store `tokens_in = prompt_token_count −
cached_content_token_count`, `cache_read_tokens = cached_content_token_count`,
`tokens_out = candidates_token_count`. `thoughts_token_count` is tracked as its own
lane.

## Pinned: step envelope — `gemini_coder.Step` (`trajectory.proto`)

| Field | # | Type |
|---|---|---|
| `type` | 1 | `CortexStepType` (enum; independent numbering from oneof kind) |
| `status` | 4 | `CortexStepStatus` |
| `metadata` | 5 | `CortexStepMetadata` (`created_at` at `1 → 1`/`2`) |
| `subtrajectory` | 6 | `gemini_coder.Trajectory` |
| `error` | 31 | `CortexErrorDetails` |
| `requested_interaction` | 56 | `exa.cortex_pb.RequestedInteraction` |
| `permissions` | 133 | `exa.cortex_pb.TrajectoryPermissions` |
| `completed_interactions` | 147 | `repeated exa.cortex_pb.CompletedInteraction` |
| `task_details` | 148 | `gemini_coder.TaskDetails` |
| `custom_extensions` | 158 | `exa.cortex_pb.CustomExtensions` |
| `generic_step` | 159 | `gemini_coder.Step` |

## Pinned: step-kind taxonomy — the `oneof step` payload field numbers

122 kinds in `src/import/antigravity/fieldmap.ts` (`STEP_PAYLOAD_KINDS`, including CLI
additions `156: 'directory_rules'` and `157: 'tool_search'`). The **step kind is the
`oneof step` payload field that is present** inside a decoded `step_payload` — this is
the reliable discriminator, and `decodeStepEnvelope` reads it that way.

> **Correction (PR #44 review):** an earlier draft claimed the oneof field number
> *equals* the `steps.step_type` column. It does **not**. `step_type` is the
> `CortexStepType` enum (its own numbering in `cortex.proto`); the
> present oneof field is a different number. Verified against real rows:
> `step_type 14 → user_input (oneof 19)`, `15 → planner_response (20)`,
> `23 → checkpoint (30)`, `90 → ephemeral_message (103)`, `98 → conversation_history
> (111)`. Do **not** map kinds from `step_type`; map from the present oneof field.

Representative kinds relevant to the event taxonomy:

| # | kind | event category |
|---|---|---|
| 8 | `plan_input` / 19 `user_input` / 154 `ask_question` | prompt |
| 20 | `planner_response` / 156 `directory_rules` | response (`llm_response` comes from `gen_metadata`) |
| 28 | `run_command` / 37 `command_status` / 157 `tool_search` | tool_use |
| 10 | `code_action` / 23 `write_to_file` / 98 `file_change` | file_change |
| 13 | `grep_search` / 14 `view_file` / 15 `list_directory` / 85 `code_search` | tool_use |
| 47 | `mcp_tool` / 116 `agency_tool_call` / 143 `invoke_subagent` | tool_use |
| 12 | `finish` | session_end |
| 24 | `error_message` | error |
| 30 | `checkpoint` | plan_step |

## Regenerating

Re-run `protodump` on desktop binaries or scan `agy` for embedded `FileDescriptorProto`
blobs after any Antigravity update, then refresh `src/import/antigravity/fieldmap.ts`
and the Appendix below.

## Appendix: `src/import/antigravity/fieldmap.ts`

```ts
export const USAGE_METADATA_FIELDS = {
  promptTokenCount: 1,
  candidatesTokenCount: 2,
  totalTokenCount: 3,
  cachedContentTokenCount: 5,
  toolUsePromptTokenCount: 13,
  thoughtsTokenCount: 14,
} as const;

export const GEN_METADATA_WRAPPER_FIELD = 1;

export const GENERATOR_METADATA_FIELDS = {
  usage: 4,
  chatStartMetadata: 9,
  model: 19,
  modelDisplay: 21,
  modelFull: 22,
} as const;

export const CHAT_START_METADATA_FIELDS = {
  createdAt: 4,
} as const;

export const CORTEX_USAGE_FIELDS = {
  modelEnum: 1,
  inputTokens: 2,
  outputTokens: 3,
  cacheWriteTokens: 4,
  cacheReadTokens: 5,
  messageId: 7,
  thinkingTokens: 9,
  answerTokens: 10,
  providerAssignedMessageId: 12,
} as const;

export const PLANNER_RESPONSE_FIELDS = {
  messageId: 6,
  providerAssignedMessageId: 15,
} as const;

export const STEP_FIELDS = {
  type: 1,
  status: 4,
  metadata: 5,
  error: 31,
  subtrajectory: 6,
  taskDetails: 148,
  customExtensions: 158,
  genericStep: 159,
} as const;
```

`STEP_PAYLOAD_KINDS` in `src/import/antigravity/fieldmap.ts` holds all 122 `oneof step`
payload kinds (`7..154` from the original 120-kind map plus `156: 'directory_rules'`
and `157: 'tool_search'`).
