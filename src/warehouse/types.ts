import type {
  TraceQualityCostCoverage,
  TraceQualityCostProvenance,
  TraceQualityTimestampCoverage,
  TraceQualityToolOutcomeCoverage,
  TraceQualityUsageCoverage,
} from '../trace-quality/types.js';

export interface WarehouseRunRow {
  account: string;
  session_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  observation_count: number;
  error_count: number;
  quality_score: number | null;
  quality_grade: string | null;
  project: string | null;
  agent_type: string | null;
  started_at: string;
  day: string;
  published_run_id: string;
  usage_coverage: TraceQualityUsageCoverage;
  cost_coverage: TraceQualityCostCoverage;
  cost_provenance: TraceQualityCostProvenance;
  timestamp_coverage: TraceQualityTimestampCoverage;
  tool_outcome_coverage: TraceQualityToolOutcomeCoverage;
  has_full_transcript: boolean;
}

export interface PublishLineage {
  run_id: string;
  created_at: string;
  account: string;
  window_start: string | null;
  window_end: string | null;
  sessions_published: number;
  sessions_suppressed: number;
  min_batch: number;
  amon_version: string;
  grant_role: string | null;
  grant_skipped: boolean;
}

export interface WarehouseConfig {
  enabled: boolean;
  dsn: string | null;
  account: string;
  schema: string;
  biRole: string | null;
}
