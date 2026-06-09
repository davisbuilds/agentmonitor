<script lang="ts">
  import { Badge, Button, Select, EmptyState } from '../ui';
  import type {
    TraceQualityFinding,
    TraceQualityFindingKind,
    TraceQualityFindingSeverity,
    TraceQualityFindingEvidence,
  } from '../../api/client';

  interface Props {
    findings: TraceQualityFinding[];
    loading: boolean;
    error: string | null;
    kind: TraceQualityFindingKind | '';
    severity: TraceQualityFindingSeverity | '';
    onkind: (kind: TraceQualityFindingKind | '') => void;
    onseverity: (severity: TraceQualityFindingSeverity | '') => void;
    caninspect: (finding: TraceQualityFinding) => boolean;
    oninspect: (finding: TraceQualityFinding) => void;
  }

  let { findings, loading, error, kind, severity, onkind, onseverity, caninspect, oninspect }: Props = $props();

  // Full taxonomy so the filter offers every kind even when none are currently firing.
  const KIND_OPTIONS = [
    'high_error_rate', 'tool_failure_rate', 'model_error_rate', 'rate_limit_events',
    'high_latency_p95', 'latency_spike', 'token_spike', 'cost_anomaly',
    'daily_budget_risk', 'unknown_pricing', 'low_trace_coverage',
    'collector_or_otel_dropoff', 'low_quality_score', 'observation_error',
  ].map((value) => ({ value, label: value.replace(/_/g, ' ') }));

  const SEVERITY_OPTIONS = ['info', 'warning', 'high', 'critical'].map((value) => ({ value, label: value }));

  function severityTone(s: TraceQualityFindingSeverity): 'neutral' | 'accent' | 'warn' | 'danger' {
    if (s === 'critical' || s === 'high') return 'danger';
    if (s === 'warning') return 'warn';
    return 'accent';
  }

  function formatMetric(value: number | undefined, unit: TraceQualityFindingEvidence['unit']): string {
    if (value == null) return '—';
    switch (unit) {
      case 'ratio': return `${(value * 100).toFixed(1)}%`;
      case 'usd': return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
      case 'ms': return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
      case 'minutes': return `${Math.round(value)}m`;
      case 'tokens':
      case 'count':
      default: return new Intl.NumberFormat('en-US').format(value);
    }
  }

  function windowLabel(w: TraceQualityFindingEvidence['window']): string | null {
    if (!w) return null;
    if (w.label) return w.label;
    if (w.from && w.to) return `${w.from} → ${w.to}`;
    return w.from ?? w.to ?? null;
  }
</script>

<section class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-h3">Findings</h3>
    <div class="flex items-center gap-2">
      <Select
        value={kind}
        options={KIND_OPTIONS}
        placeholder="All kinds"
        aria-label="Filter findings by kind"
        onchange={(value) => onkind(value as TraceQualityFindingKind | '')}
      />
      <Select
        value={severity}
        options={SEVERITY_OPTIONS}
        placeholder="All severities"
        aria-label="Filter findings by severity"
        onchange={(value) => onseverity(value as TraceQualityFindingSeverity | '')}
      />
    </div>
  </div>

  {#if error}
    <div class="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">{error}</div>
  {:else if loading && findings.length === 0}
    <div class="rounded-sm border border-line bg-surface px-4 py-10 text-center text-meta text-text-muted">Computing findings…</div>
  {:else if findings.length === 0}
    <EmptyState title="No findings for the current filters." description="A clean window means no error, latency, cost, coverage, or quality thresholds were tripped." />
  {:else}
    <div class="space-y-2">
      {#each findings as finding (finding.id)}
        {@const ev = finding.evidence}
        <div class="rounded-sm border border-line bg-surface p-3 space-y-1.5">
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
              <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
              <span class="truncate text-body text-text">{finding.title}</span>
            </div>
            {#if caninspect(finding)}
              <Button variant="ghost" size="sm" onclick={() => oninspect(finding)}>Inspect</Button>
            {/if}
          </div>

          <p class="text-meta text-text-muted">{finding.message}</p>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-faint">
            <span class="font-mono text-text-muted">{finding.kind.replace(/_/g, ' ')}</span>
            {#if ev.metric_value != null && ev.threshold != null}
              <span class="font-mono">
                {formatMetric(ev.metric_value, ev.unit)} {ev.comparator === 'lte' ? '≤' : '≥'} {formatMetric(ev.threshold, ev.unit)}
              </span>
            {:else if ev.metric_value != null}
              <span class="font-mono">{formatMetric(ev.metric_value, ev.unit)}</span>
            {/if}
            {#if ev.baseline_value != null}
              <span class="font-mono">baseline {formatMetric(ev.baseline_value, ev.unit)}</span>
            {/if}
            {#if ev.dimension}
              <span>{ev.dimension.type}: <span class="font-mono text-text-muted">{ev.dimension.value}</span></span>
            {/if}
            {#if ev.sample_size != null}<span class="font-mono">n={ev.sample_size}</span>{/if}
            {#if ev.impacted_total != null}<span class="font-mono">{ev.impacted_total} impacted</span>{/if}
            {#if windowLabel(ev.window)}<span>{windowLabel(ev.window)}</span>{/if}
          </div>

          {#if ev.coverage_caveat}
            <p class="text-meta italic text-text-faint">{ev.coverage_caveat}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
