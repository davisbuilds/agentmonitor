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

// WHY: Silent drops previously hid unsupported operational metrics. Count dropped names without
// collecting their payloads.
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

  /** Count records the parser refused before they became events. */
  refuse(count: number, problem: string): void {
    if (count === 0) return;
    this.rejected += count;
    this.problems.add(problem);
  }

  /** OTLP's partial-success response, or the plain `{}` when nothing was refused. */
  response(rejectedField: 'rejectedLogRecords' | 'rejectedDataPoints'): Record<string, unknown> {
    if (this.rejected === 0) return {};
    const errorMessage = `Refused by the ingest contract: ${[...this.problems].join('; ')}`;
    console.warn(`[otel] ${errorMessage} (${this.rejected} ${rejectedField === 'rejectedLogRecords' ? 'log records' : 'data points'})`);
    return { partialSuccess: { [rejectedField]: this.rejected, errorMessage } };
  }
}

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

otelRouter.post('/v1/metrics', (req: Request, res: Response) => {
  if (!requireJson(req, res)) return;

  const payload = coerceJsonLikeBody(req.body);
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid OTEL JSON payload' });
    return;
  }
  const { usage, operational, dropped, refused } = parseOtelMetrics(payload as OtelMetricsPayload);

  const reportedCost = new Set(usage.filter(d => d.cost_usd_delta > 0).map(d => `${d.session_id}|${d.model ?? ''}`));
  const admission = new OtlpAdmission();
  admission.refuse(refused.count, `${refused.metrics.join(', ')} value must be a finite non-negative number`);
  for (const delta of usage) {
    const event = admission.admit({
      event_id: delta.event_id,
      session_id: delta.session_id,
      agent_type: delta.agent_type,
      event_type: 'llm_response',
      status: 'success',
      tokens_in: delta.tokens_in_delta,
      tokens_out: delta.tokens_out_delta,
      cache_read_tokens: delta.cache_read_delta,
      cache_write_tokens: delta.cache_write_delta,
      cost_usd: delta.cost_usd_delta > 0 || reportedCost.has(`${delta.session_id}|${delta.model ?? ''}`)
        ? delta.cost_usd_delta
        : undefined,
      model: delta.model,
      client_timestamp: delta.client_timestamp,
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

  if (operational.length > 0) insertOperationalMetrics(operational);

  recordDropped(dropped);

  res.status(200).json(admission.response('rejectedDataPoints'));
});

/** The spans an OTLP traces payload carries, counting only well-formed arrays. */
function countSpans(payload: object): number {
  const arrayAt = (value: unknown, key: string): unknown[] => {
    const field = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
    return Array.isArray(field) ? field : [];
  };
  let count = 0;
  for (const resource of arrayAt(payload, 'resourceSpans')) {
    for (const scope of arrayAt(resource, 'scopeSpans')) count += arrayAt(scope, 'spans').length;
  }
  return count;
}

// WHY: Exporters retry refused batches every few seconds, so throttle the warning.
let discardedSpans = 0;
let lastSpanWarn = 0;

otelRouter.post('/v1/traces', (req: Request, res: Response) => {
  if (!requireJson(req, res)) return;
  const payload = coerceJsonLikeBody(req.body);
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid OTEL JSON payload' });
    return;
  }

  const spans = countSpans(payload);
  if (spans === 0) {
    res.status(200).json({});
    return;
  }
  discardedSpans += spans;
  const now = Date.now();
  if (now - lastSpanWarn >= DROP_FLUSH_INTERVAL_MS) {
    console.warn(`[otel] discarded ${discardedSpans} spans since last warning: span ingestion is not implemented`);
    discardedSpans = 0;
    lastSpanWarn = now;
  }
  res.status(200).json({
    partialSuccess: { rejectedSpans: spans, errorMessage: 'Span ingestion is not implemented; spans were discarded' },
  });
});
