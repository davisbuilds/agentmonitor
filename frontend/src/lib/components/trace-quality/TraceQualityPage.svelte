<script lang="ts">
  import { onMount } from 'svelte';
  import { traceQuality } from '../../stores/trace-quality.svelte';
  import { Badge, Button, Stat } from '../ui';
  import TraceCoverageBadge from './TraceCoverageBadge.svelte';
  import TraceTree from './TraceTree.svelte';
  import ScoreEditor from './ScoreEditor.svelte';

  const tq = traceQuality;

  function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }
  function formatCost(value: number): string {
    return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
  }
  function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60000)}m`;
  }
  function formatDateTime(value: string | null): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }
  function formatAgent(agent: string): string {
    return agent === 'claude_code' ? 'claude' : agent;
  }

  onMount(() => {
    void tq.initialize();
    return () => tq.dispose();
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
  {#if tq.sessionScope}
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-accent/30 bg-accent/10 px-3 py-2 text-meta text-text-muted">
      <span>Scoped to session <span class="font-mono text-text">{tq.sessionScope}</span> (date filter ignored).</span>
      <Button variant="ghost" size="sm" onclick={() => tq.clearSessionScope()}>Clear scope</Button>
    </div>
  {/if}

  {#if tq.coverage}
    <div class="rounded-sm border border-line bg-surface-2 px-3 py-2 text-meta text-text-muted">
      <span class="text-text">{formatNumber(tq.coverage.included_traces)}</span> of
      <span class="text-text">{formatNumber(tq.coverage.matching_traces)}</span> matching traces shown.
      {tq.coverage.note}
    </div>
  {/if}

  {#if tq.error}
    <div class="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-meta text-danger">{tq.error}</div>
  {/if}

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <!-- Trace list -->
    <section class="rounded-lg border border-line bg-surface xl:col-span-4">
      <div class="border-b border-line px-4 py-3">
        <h3 class="text-h3">Traces</h3>
        <div class="mt-0.5 text-meta text-text-muted">
          {tq.traces.length} trace{tq.traces.length === 1 ? '' : 's'} in this slice
        </div>
      </div>

      <div class="max-h-[72vh] overflow-y-auto">
        {#if tq.loading}
          <div class="px-4 py-12 text-center text-meta text-text-muted">Loading traces…</div>
        {:else if tq.traces.length === 0}
          <div class="px-4 py-12 text-center text-meta text-text-muted">No traces for the current filters.</div>
        {:else}
          <div class="divide-y divide-line/60">
            {#each tq.traces as trace (trace.id)}
              <button
                class={`block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${tq.selectedTraceId === trace.id ? 'bg-surface-2' : ''}`}
                onclick={() => tq.selectTrace(trace.id)}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1 truncate font-medium text-text">{trace.name}</div>
                  <div class="shrink-0 font-mono tabular text-meta text-text-faint">{formatCost(trace.aggregate.total_cost_usd)}</div>
                </div>
                <div class="mt-1.5"><TraceCoverageBadge {trace} compact /></div>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-text-faint">
                  <span>{formatAgent(trace.agent_type)}</span>
                  <span class="font-mono">{formatNumber(trace.aggregate.observation_count)} obs</span>
                  {#if trace.aggregate.error_count > 0}<Badge tone="danger">{trace.aggregate.error_count} err</Badge>{/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <!-- Trace inspector -->
    <section class="rounded-lg border border-line bg-surface xl:col-span-8">
      {#if tq.detailLoading}
        <div class="px-4 py-16 text-center text-meta text-text-muted">Loading trace…</div>
      {:else if tq.detailError}
        <div class="px-4 py-16 text-center text-meta text-danger">{tq.detailError}</div>
      {:else if tq.detail}
        {@const d = tq.detail}
        <div class="border-b border-line px-4 py-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-h2 truncate">{d.name}</h2>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-meta text-text-faint">
                <span>{formatAgent(d.agent_type)}</span>
                {#if d.status}<Badge tone={d.status === 'error' ? 'danger' : 'neutral'}>{d.status}</Badge>{/if}
                {#if d.project}<span>{d.project}</span>{/if}
                <span class="font-mono">{formatDateTime(d.started_at)}</span>
              </div>
              <div class="mt-2"><TraceCoverageBadge trace={d} /></div>
            </div>
            <Button variant="ghost" size="sm" onclick={() => tq.clearSelection()}>Close</Button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line md:grid-cols-4">
          <div class="bg-surface px-4 py-3"><Stat label="Observations" value={formatNumber(d.aggregate.observation_count)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Errors" value={formatNumber(d.aggregate.error_count)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Tokens" value={formatNumber(d.aggregate.total_tokens_in + d.aggregate.total_tokens_out)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Cost" value={formatCost(d.aggregate.total_cost_usd)} /></div>
        </div>

        <!-- Observation tree -->
        <div class="border-b border-line">
          <div class="px-4 py-2 text-meta font-medium text-text">Observations</div>
          {#if tq.tree.length === 0}
            <div class="px-4 pb-4 text-meta text-text-faint">No observations projected for this trace.</div>
          {:else}
            <TraceTree nodes={tq.tree} selectedId={tq.selectedObservationId} onselect={(id) => tq.selectObservation(id)} />
          {/if}
        </div>

        <!-- Selected observation summary (payload-policy-safe) -->
        {#if tq.observationDetail}
          {@const o = tq.observationDetail}
          <div class="border-b border-line px-4 py-3 space-y-2">
            <div class="flex flex-wrap items-center gap-2 text-meta text-text-faint">
              <span class="text-text">{o.name}</span>
              <Badge tone="neutral">{o.observation_type}</Badge>
              {#if o.model}<span class="font-mono">{o.model}</span>{/if}
              {#if o.tool_name}<span class="font-mono">tool: {o.tool_name}</span>{/if}
              <span class="font-mono">{formatDuration(o.duration_ms)}</span>
              <Badge tone="neutral" title="Payload retention policy for this observation">policy: {o.payload_policy}</Badge>
            </div>
            {#if o.input_summary}
              <div><span class="text-meta text-text-faint">Input: </span><span class="text-meta text-text-muted">{o.input_summary}</span></div>
            {:else if o.input_hash}
              <div class="text-meta text-text-faint">Input hash: <span class="font-mono">{o.input_hash}</span> <span class="italic">(raw content not retained)</span></div>
            {/if}
            {#if o.output_summary}
              <div><span class="text-meta text-text-faint">Output: </span><span class="text-meta text-text-muted">{o.output_summary}</span></div>
            {:else if o.output_hash}
              <div class="text-meta text-text-faint">Output hash: <span class="font-mono">{o.output_hash}</span> <span class="italic">(raw content not retained)</span></div>
            {/if}
          </div>
        {/if}

        <!-- Local review scores -->
        <div class="px-4 py-4">
          <ScoreEditor
            target={tq.scoreTarget}
            scores={tq.targetScores}
            saving={tq.savingScore}
            error={tq.scoreError}
            onadd={(input) => tq.addScore(input)}
            onremove={(id) => tq.removeScore(id)}
          />
        </div>
      {:else}
        <div class="px-4 py-16 text-center text-meta text-text-muted">
          Select a trace to inspect its observation tree and attach local review scores.
        </div>
      {/if}
    </section>
  </div>
</main>
