import { Router, type Request, type Response } from 'express';
import { insertEvent } from '../db/queries.js';
import { insertOperationalMetrics } from '../db/otel-metrics.js';
import { broadcaster } from '../sse/emitter.js';
import { coerceJsonLikeBody } from './json-body.js';
import {
  parseOtelLogs,
  parseOtelMetrics,
  type OtelLogsPayload,
  type OtelMetricsPayload,
} from '../otel/parser.js';
import { safelyMaintainTraceSummaryForEvent } from '../trace-quality/service.js';
import { normalizeIngestEvent, type NormalizedIngestEvent } from '../contracts/event-contract.js';

export const otelRouter = Router();

// Intake visibility for dropped metrics. The metrics endpoint used to silently
// discard everything it did not recognize; that blindness hid the Codex
// operational-counter gap for months ("an absence is a claim about the
// instrument"). We now keep a throttled aggregate tally of what we drop — names
// only, never datapoints — so the stream is observable without bloating anything.
const droppedTally = new Map<string, number>();
let lastDropFlush = 0;
const DROP_FLUSH_INTERVAL_MS = 60_000;

function recordDropped(dropped: Record<string, number>): void {
  for (const [name, count] of Object.entries(dropped)) {
    droppedTally.set(name, (droppedTally.get(name) ?? 0) + count);
  }
  const now = Date.now();
  if (droppedTally.size > 0 && now - lastDropFlush >= DROP_FLUSH_INTERVAL_MS) {
    const top = [...droppedTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.warn(`[otel] dropped ${top.reduce((s, [, c]) => s + c, 0)} unstored metric datapoints since last flush: `
      + top.map(([n, c]) => `${n}×${c}`).join(', '));
    droppedTally.clear();
    lastDropFlush = now;
  }
}

/**
 * Hold every OTLP-derived event to the same contract as `POST /api/events`, so
 * a negative or non-finite token or cost value cannot reach storage and drag
 * SUM() totals. A latency is the one field rounded rather than refused: OTLP
 * carries it as a double, and a fractional millisecond is not bad data.
 */
class OtlpAdmission {
  rejected = 0;
  private readonly problems = new Set<string>();

  admit(candidate: NormalizedIngestEvent): NormalizedIngestEvent | null {
    const duration = candidate.duration_ms;
    const input = typeof duration === 'number' && Number.isFinite(duration)
      ? { ...candidate, duration_ms: Math.round(duration) }
      : candidate;
    const result = normalizeIngestEvent(input);
    if (result.ok) return result.event;
    this.rejected++;
    for (const error of result.errors) this.problems.add(`${error.field} ${error.message}`);
    return null;
  }

  /** OTLP's partial-success response, or the plain `{}` when nothing was refused. */
  response(rejectedField: 'rejectedLogRecords' | 'rejectedDataPoints'): Record<string, unknown> {
    if (this.rejected === 0) return {};
    const errorMessage = `Refused by the ingest contract: ${[...this.problems].join('; ')}`;
    console.warn(`[otel] ${errorMessage} (${this.rejected} ${rejectedField === 'rejectedLogRecords' ? 'log records' : 'data points'})`);
    return { partialSuccess: { [rejectedField]: this.rejected, errorMessage } };
  }
}

// Content-Type guard: JSON only (415 for protobuf)
function requireJson(req: Request, res: Response): boolean {
  const ct = req.headers['content-type'] ?? '';
  if (ct.includes('application/x-protobuf') || ct.includes('application/protobuf')) {
    res.status(415).json({
      error: 'Protobuf not supported yet. Use JSON format.',
      hint: 'Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
    });
    return false;
  }
  return true;
}

// POST /api/otel/v1/logs
otelRouter.post('/v1/logs', (req: Request, res: Response) => {
  if (!requireJson(req, res)) return;

  const payload = coerceJsonLikeBody(req.body);
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid OTEL JSON payload' });
    return;
  }
  const events = parseOtelLogs(payload as OtelLogsPayload);
  const admission = new OtlpAdmission();

  for (const parsed of events) {
    const event = admission.admit(parsed);
    if (!event) continue;
    const row = insertEvent(event);
    if (row) {
      broadcaster.broadcast('event', row as unknown as Record<string, unknown>);
      safelyMaintainTraceSummaryForEvent(row.id, 'otel log ingest');
    }
  }

  res.status(200).json(admission.response('rejectedLogRecords'));
});

// POST /api/otel/v1/metrics
otelRouter.post('/v1/metrics', (req: Request, res: Response) => {
  if (!requireJson(req, res)) return;

  const payload = coerceJsonLikeBody(req.body);
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid OTEL JSON payload' });
    return;
  }
  const { usage, operational, dropped } = parseOtelMetrics(payload as OtelMetricsPayload);

  // Token/cost usage metrics (Claude Code OTEL) → synthetic llm_response, so the
  // existing event pipeline aggregates tokens/cost per session. Codex token/cost
  // metrics are deliberately not here — logs are authoritative (see parser).
  const admission = new OtlpAdmission();
  for (const delta of usage) {
    const hasCost = delta.cost_usd_delta > 0;
    const event = admission.admit({
      session_id: delta.session_id,
      agent_type: delta.agent_type,
      event_type: 'llm_response',
      status: 'success',
      tokens_in: delta.tokens_in_delta,
      tokens_out: delta.tokens_out_delta,
      cache_read_tokens: delta.cache_read_delta,
      cache_write_tokens: delta.cache_write_delta,
      cost_usd: hasCost ? delta.cost_usd_delta : undefined,
      model: delta.model,
      metadata: { _synthetic: true, _source: 'otel_metric' },
      source: 'otel',
    });
    if (!event) continue;
    const row = insertEvent(event);

    if (row) {
      broadcaster.broadcast('event', row as unknown as Record<string, unknown>);
      safelyMaintainTraceSummaryForEvent(row.id, 'otel metric ingest');
    }
  }

  // Bucket A operational metrics → dedicated otel_metrics table (never events).
  if (operational.length > 0) insertOperationalMetrics(operational);

  recordDropped(dropped);

  res.status(200).json(admission.response('rejectedDataPoints'));
});

// POST /api/otel/v1/traces — stub for future implementation
otelRouter.post('/v1/traces', (req: Request, res: Response) => {
  if (!requireJson(req, res)) return;
  const payload = coerceJsonLikeBody(req.body);
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid OTEL JSON payload' });
    return;
  }

  // Accept and acknowledge traces but don't process them yet
  res.status(200).json({});
});
