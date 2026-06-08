export const TRACE_QUALITY_OBSERVATION_TYPES = [
  'event',
  'span',
  'generation',
  'agent',
  'tool',
  'evaluator',
  'guardrail',
  'chain',
  'retriever',
  'embedding',
] as const;

export const TRACE_QUALITY_SOURCE_KINDS = [
  'event',
  'message',
  'tool_call',
  'session_turn',
  'session_item',
  'browsing_session',
  'otel_span',
  'live_item',
  'api',
] as const;

export const TRACE_QUALITY_SCORE_TARGET_TYPES = [
  'session',
  'browsing_session',
  'trace',
  'observation',
  'message',
  'event',
  'session_item',
  'tool_call',
] as const;

export const TRACE_QUALITY_SCORE_VALUE_TYPES = [
  'numeric',
  'categorical',
  'boolean',
  'text',
] as const;

export const TRACE_QUALITY_SCORE_SOURCES = [
  'human',
  'api',
  'code_evaluator',
  'llm_judge',
  'system',
] as const;

export const TRACE_QUALITY_PROMPT_REF_SOURCES = [
  'metadata',
  'skill_file',
  'agent_instruction',
  'task_template',
  'system_prompt',
  'manual',
  // Legacy values kept readable for existing local databases and seeded rows.
  'file',
  'inline',
  'skill',
  'template',
] as const;

export const TRACE_QUALITY_PAYLOAD_POLICIES = [
  'summary_only',
  'hash_only',
  'source_ref',
  'raw_allowed',
] as const;

export const TRACE_QUALITY_PROJECTION_STATUSES = [
  'projected',
  'failed',
  'skipped',
  'stale',
] as const;

export const TRACE_QUALITY_EXPORT_PROVIDERS = [
  'langfuse',
] as const;

export const TRACE_QUALITY_EXPORT_STATUSES = [
  'pending',
  'exported',
  'failed',
  'skipped',
] as const;

export const TRACE_QUALITY_COVERAGE_KEYS = [
  'has_full_transcript',
  'has_tool_details',
  'has_token_usage',
  'has_cost',
  'has_parent_child_structure',
  'has_raw_input',
  'has_raw_output',
  'has_reasoning',
  'has_prompt_refs',
  'projection_source',
  'projection_confidence',
] as const;
