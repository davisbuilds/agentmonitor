---
date: 2026-07-01
topic: antigravity-cli-import
stage: baseline
status: complete
source: binary-extraction
---

# Antigravity Proto Field Map (Baseline)

Authoritative field numbers for decoding Antigravity CLI conversation databases
(`~/.gemini/antigravity-cli/conversations/<uuid>.db`). Realizes Task 1 of
`docs/plans/2026-07-01-antigravity-cli-import-plan.md` and gates spec criterion #7
(descriptor-pinned, not reverse-engineered).

## Provenance

Extracted from the shipped Antigravity `language_server` Go binary
(`/Applications/Antigravity.app/Contents/Resources/bin/language_server`, arm64)
using [`protodump`](https://github.com/arkadiyt/protodump), which reconstructs
embedded `FileDescriptorProto`s:

```bash
go install github.com/arkadiyt/protodump/cmd/protodump@latest
protodump -file "/Applications/Antigravity.app/Contents/Resources/bin/language_server" -output ./protos
# 76 .proto files recovered. Key files:
#   third_party/gemini_coder/proto/trajectory.proto        (Step envelope + taxonomy)
#   google/cloud/aiplatform/master/usage_metadata.proto    (token counts)
```

The typed subset is captured in the Appendix below; it lands in
`src/import/antigravity/fieldmap.ts` in Task 2, alongside the decoder that consumes
it (an unconsumed constants module would trip the dead-code gate).

## SQLite → proto mapping

Each conversation `.db` has a `steps` table whose columns are a decomposed
`gemini_coder.Step`: `step_type` = `Step.type`, `metadata`/`error_details`/
`task_details` = the same-named Step fields, and `step_payload` = the serialized
`oneof step` payload for that kind. `gen_metadata` holds the per-generation record
(model + `UsageMetadata`).

## Pinned: token usage — `google.cloud.aiplatform.master.UsageMetadata`

Google's **stable public** schema, so these numbers are version-durable:

| Field | # |
|---|---|
| `prompt_token_count` | 1 |
| `candidates_token_count` | 2 |
| `total_token_count` | 3 |
| `cached_content_token_count` | 5 |
| `tool_use_prompt_token_count` | 13 |
| `thoughts_token_count` | 14 |

**Cache-inclusive invariant (resolves spec Open Question #2):** `prompt_token_count`
*includes* cached tokens. Store `tokens_in = prompt_token_count −
cached_content_token_count`, `cache_read_tokens = cached_content_token_count`,
`tokens_out = candidates_token_count`. `thoughts_token_count` is tracked as its own
lane. Skipping the subtraction double-bills the cached bulk at full input rate
(~10×) — the same trap the pricing engine already guards for OpenAI/Codex.

## Pinned: step envelope — `gemini_coder.Step` (`trajectory.proto`)

| Field | # | Type |
|---|---|---|
| `type` | 1 | `CortexStepType` (enum; mirrors payload-kind number) |
| `status` | 4 | `CortexStepStatus` |
| `metadata` | 5 | `CortexStepMetadata` (carries model + usage) |
| `error` | 31 | `CortexErrorDetails` |
| `subtrajectory` | 6 | `gemini_coder.Trajectory` |
| `task_details` | 148 | `gemini_coder.TaskDetails` |

## Pinned: step-kind taxonomy — the `oneof step` payload field numbers

120 kinds (full map in the Appendix / Task 2 `fieldmap.ts`). The payload field number *is* the step-kind
discriminator, and it **equals the `steps.step_type` column** — verified against all
observed values: `14=view_file`, `15=list_directory`, `23=write_to_file`,
`90=browser_scroll_down`, `98=file_change`. Representative kinds relevant to the
event taxonomy (final mapping is Task 3):

| # | kind | likely event category |
|---|---|---|
| 8 | `plan_input` / 19 `user_input` | prompt |
| 20 | `planner_response` | llm_response |
| 28 | `run_command` / 37 `command_status` | tool_use |
| 10 | `code_action` / 23 `write_to_file` / 98 `file_change` | tool_use |
| 13 | `grep_search` / 14 `view_file` / 15 `list_directory` / 85 `code_search` | tool_use |
| 47 | `mcp_tool` / 116 `agency_tool_call` | tool_use |
| 12 | `finish` / 93 `task_boundary` | lifecycle |
| 24 | `error_message` | error |
| 30 | `checkpoint` / 103 `ephemeral_message` / 114 `system_message` | lifecycle/meta |

## NOT pinned (fixture-verified in Task 2)

The private `exa.cortex_pb` file (`third_party/jetski/cortex_pb/cortex.proto`) is
present in the binary but **not recovered by protodump's scanner** (neither written
nor errored — a scanner limitation, not a write failure). So these internals are
decoded empirically against fixtures, cross-checked with the plaintext strings we
know survive:

- `CortexStepMetadata` internal layout — exactly where `model` and the
  `UsageMetadata` sub-message nest within `gen_metadata`. Recon (raw wire-walk)
  located model near `gen_metadata` fields 1.19/1.21 and a usage block at 1.17.2.* /
  1.4.* — treat as **unverified** until the Task 2 fixture asserts it.
- Per-kind payload message fields (e.g. `CortexStepRunCommand` command/output).

This partial-pin is intentional and honest: the cost-bearing surface (token counts +
step taxonomy + envelope) is descriptor-pinned; only private payload internals ride
fixtures.

## Regenerating

Re-run the `protodump` command above after any Antigravity update, then regenerate
the Appendix map (parse the `oneof step` block of `trajectory.proto`) to refresh
`fieldmap.ts`. Google's `UsageMetadata`
numbers are stable; the `gemini_coder`/`exa.cortex_pb` envelope may shift across
versions — the Task 2 fixture test is the drift alarm.

## Appendix: generated `fieldmap.ts` (lands in Task 2 with the decoder)

This module is captured here for review but intentionally **not** committed to
`src/` yet — an unconsumed constants module trips the repo's dead-code gate
(`tests/codebase/dead-code.test.ts`). Task 2's decoder imports it, at which point
it moves to `src/import/antigravity/fieldmap.ts`.

```ts
// Antigravity CLI protobuf field map — descriptor-pinned.
//
// Source of truth: FileDescriptorProtos extracted from the Antigravity
// `language_server` binary via `protodump` (see
// docs/specs/baselines/antigravity-proto-fieldmap.md for provenance + regen).
// The Step envelope + step-kind taxonomy come from
// third_party/gemini_coder/proto/trajectory.proto; token fields from
// google/cloud/aiplatform/master/usage_metadata.proto (Google's stable public schema).
//
// NOT pinned here (private exa.cortex_pb payload internals — cortex.proto is
// present in the binary but not recoverable by protodump's scanner): the
// per-kind payload message fields and CortexStepMetadata's model/usage nesting.
// Those are fixture-verified in the decoder (Task 2), not guessed.

/** google.cloud.aiplatform.master.UsageMetadata — token counts (all int32). */
export const USAGE_METADATA_FIELDS = {
  promptTokenCount: 1,
  candidatesTokenCount: 2,
  totalTokenCount: 3,
  cachedContentTokenCount: 5,
  toolUsePromptTokenCount: 13,
  thoughtsTokenCount: 14,
} as const;

/**
 * Cache-inclusive invariant: Google's promptTokenCount INCLUDES cached tokens,
 * so the store must subtract them (mirrors the Codex/OpenAI handling).
 *   tokens_in       = promptTokenCount - cachedContentTokenCount
 *   cache_read      = cachedContentTokenCount
 *   tokens_out      = candidatesTokenCount (thoughtsTokenCount tracked separately)
 */
export const THOUGHTS_ARE_SEPARATE = true;

/** gemini_coder.Step envelope (trajectory.proto). */
export const STEP_FIELDS = {
  type: 1,          // exa.cortex_pb.CortexStepType (enum; mirrors payload kind number)
  status: 4,        // exa.cortex_pb.CortexStepStatus
  metadata: 5,      // exa.cortex_pb.CortexStepMetadata (holds model + usage; internals fixture-verified)
  error: 31,        // exa.cortex_pb.CortexErrorDetails
  subtrajectory: 6, // gemini_coder.Trajectory
  taskDetails: 148, // gemini_coder.TaskDetails
} as const;

/**
 * Step-kind discriminator: the `oneof step` payload field number in gemini_coder.Step.
 * 120 kinds. Verified to equal the SQLite `steps.step_type` column for all
 * observed values (14=view_file, 15=list_directory, 23=write_to_file,
 * 90=browser_scroll_down, 98=file_change).
 */
export const STEP_PAYLOAD_KINDS: Record<number, string> = {
  7: 'dummy',
  8: 'plan_input',
  9: 'mquery',
  10: 'code_action',
  11: 'git_commit',
  12: 'finish',
  13: 'grep_search',
  14: 'view_file',
  15: 'list_directory',
  16: 'compile',
  19: 'user_input',
  20: 'planner_response',
  21: 'file_breakdown',
  22: 'view_code_item',
  23: 'write_to_file',
  24: 'error_message',
  28: 'run_command',
  30: 'checkpoint',
  32: 'propose_code',
  34: 'find',
  35: 'search_knowledge_base',
  36: 'suggested_responses',
  37: 'command_status',
  38: 'memory',
  39: 'lookup_knowledge_base',
  40: 'read_url_content',
  41: 'view_content_chunk',
  42: 'search_web',
  43: 'retrieve_memory',
  47: 'mcp_tool',
  48: 'manager_feedback',
  49: 'tool_call_proposal',
  50: 'tool_call_choice',
  52: 'trajectory_choice',
  55: 'clipboard',
  58: 'view_file_outline',
  59: 'check_deploy_status',
  60: 'post_pr_review',
  62: 'list_resources',
  63: 'read_resource',
  64: 'lint_diff',
  65: 'find_all_references',
  66: 'brain_update',
  67: 'open_browser_url',
  68: 'run_extension_code',
  71: 'proposal_feedback',
  72: 'trajectory_search',
  73: 'execute_browser_javascript',
  74: 'list_browser_pages',
  75: 'capture_browser_screenshot',
  76: 'click_browser_pixel',
  77: 'read_terminal',
  78: 'capture_browser_console_logs',
  79: 'read_browser_page',
  80: 'browser_get_dom',
  85: 'code_search',
  86: 'browser_input',
  87: 'browser_move_mouse',
  88: 'browser_select_option',
  89: 'browser_scroll_up',
  90: 'browser_scroll_down',
  91: 'browser_click_element',
  92: 'browser_press_key',
  93: 'task_boundary',
  94: 'notify_user',
  95: 'code_acknowledgement',
  96: 'internal_search',
  97: 'browser_subagent',
  98: 'file_change',
  100: 'move',
  101: 'browser_scroll',
  102: 'knowledge_generation',
  103: 'ephemeral_message',
  104: 'generate_image',
  105: 'delete_directory',
  106: 'compile_applet',
  107: 'install_applet_dependencies',
  108: 'install_applet_package',
  109: 'browser_resize_window',
  110: 'browser_drag_pixel_to_pixel',
  111: 'conversation_history',
  112: 'knowledge_artifacts',
  113: 'send_command_input',
  114: 'system_message',
  115: 'wait',
  116: 'agency_tool_call',
  117: 'cider_agent_dummy',
  118: 'build_cleaner',
  119: 'blaze_build_targets',
  120: 'blaze_test_targets',
  121: 'set_up_firebase',
  122: 'moma',
  123: 'restart_dev_server',
  124: 'deploy_firebase',
  125: 'browser_mouse_wheel',
  126: 'lint_applet',
  127: 'shell_exec',
  129: 'ki_insertion',
  130: 'retrieve_content',
  131: 'critique',
  132: 'findings',
  134: 'browser_mouse_up',
  135: 'browser_mouse_down',
  136: 'workspace_api',
  137: 'browser_list_network_requests',
  138: 'browser_get_network_request',
  139: 'browser_refresh_page',
  140: 'generic',
  141: 'edit_notebook',
  142: 'write_blob',
  143: 'invoke_subagent',
  144: 'read_notebook',
  145: 'propose_ai_comments',
  146: 'start_code_review',
  149: 'set_up_cloudsql',
  150: 'execute_notebook',
  151: 'cloudsql_update_schema',
  152: 'rpc_action',
  153: 'cloudsql_execute_sql',
  154: 'ask_question',
};

export type StepKind = (typeof STEP_PAYLOAD_KINDS)[number];
```
