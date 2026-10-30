<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { agentName, formatNumber } from '../../format';
  import { InfoTip } from '../ui';
  import type { SessionDepthAgent } from '../../api/client';

  const agentColor: Record<string, string> = {
    claude: 'var(--color-claude)',
    codex: 'var(--color-codex)',
    antigravity: 'var(--color-antigravity)',
  };

  // Compaction count is ordered, so one hue steps light to dark; each segment is also labeled.
  const bucketSteps: Array<{ key: keyof SessionDepthAgent['buckets']; label: string; mix: number }> = [
    { key: 'none', label: 'none', mix: 22 },
    { key: 'one', label: 'once', mix: 48 },
    { key: 'few', label: '2–3×', mix: 74 },
    { key: 'many', label: '4+×', mix: 100 },
  ];

  const bucketColor = (mix: number) => `color-mix(in oklch, var(--color-accent) ${mix}%, var(--color-surface-2))`;

  function percent(part: number, whole: number): string {
    return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="session-depth-heading">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 id="session-depth-heading" class="text-h3">Session Depth</h3>
    <InfoTip label="Session Depth">
      <p>How far sessions you started ran. A compaction means a session outgrew its context: a long investigation, a backlog sweep, cross-repo work. It marks depth, not trouble. Each agent compacts at its own context window, so they are never pooled. Only a complete transcript shows compactions, so sessions with no transcript, or one with damaged records, are counted apart.</p>
    </InfoTip>
  </div>

  {#if analytics.loading.depth && !analytics.sessionDepth}
    <div class="py-12 text-center text-meta text-text-muted">Loading session depth…</div>
  {:else if analytics.errors.depth}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.depth}</div>
  {:else if !analytics.sessionDepth || analytics.sessionDepth.agents.length === 0}
    <div class="py-12 text-center text-meta text-text-muted">No sessions in the selected range.</div>
  {:else}
    <div class="space-y-5">
      {#each analytics.sessionDepth.agents as row (row.agent)}
        <div data-testid={`session-depth-${row.agent}`}>
          <div class="flex items-baseline justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" style={`background:${agentColor[row.agent] ?? 'var(--color-accent)'}`} aria-hidden="true"></span>
              <span class="text-body font-medium text-text">{agentName(row.agent)}</span>
            </div>
            <span class="text-meta text-text-muted">
              {`${formatNumber(row.sessions)} session${row.sessions === 1 ? '' : 's'}${row.unobservable_sessions > 0 ? ` · ${formatNumber(row.unobservable_sessions)} more can't show compactions` : ''}`}
            </span>
          </div>

          <!-- With no session that can show compactions there is nothing to read; the header already says so. -->
          {#if row.sessions > 0}
            <div class="mt-2 flex items-baseline gap-2">
              <span class="tabular font-mono text-h3 text-text">{percent(row.compacted_sessions, row.sessions)}</span>
              <span class="text-meta text-text-muted">compacted · {formatNumber(row.compactions)} compaction{row.compactions === 1 ? '' : 's'}</span>
            </div>

            <div class="mt-2 flex h-2 gap-[2px] overflow-hidden rounded-sm" role="img"
              aria-label={`Sessions by compactions: ${bucketSteps.map(step => `${step.label} ${row.buckets[step.key]}`).join(', ')}`}>
              {#each bucketSteps as step}
                {#if row.buckets[step.key] > 0}
                  <span style={`flex:${row.buckets[step.key]} 1 0;background:${bucketColor(step.mix)}`}></span>
                {/if}
              {/each}
            </div>
            <div class="mt-1 flex flex-wrap gap-x-3 text-meta text-text-muted" aria-hidden="true">
              {#each bucketSteps as step}
                <span class="flex items-center gap-1">
                  <span class="h-2 w-2 rounded-[2px]" style={`background:${bucketColor(step.mix)}`}></span>
                  <span class="tabular font-mono text-text">{formatNumber(row.buckets[step.key])}</span> {step.label}
                </span>
              {/each}
            </div>

            <p class="mt-2 text-meta text-text-muted">
              {formatNumber(row.median_messages ?? 0)} messages a session at the median, {formatNumber(row.p90_messages ?? 0)} at p90
            </p>

            {#if row.deepest.length > 0}
              <ul class="mt-2 space-y-1">
                {#each row.deepest as deep (deep.id)}
                  <li class="flex items-baseline justify-between gap-3 text-meta">
                    <button class="min-w-0 truncate text-left text-text hover:text-accent focus-visible:text-accent" onclick={() => analytics.openSession(deep.id)}>
                      {deep.title ?? deep.id}
                    </button>
                    <span class="shrink-0 tabular font-mono text-text-faint">{deep.compactions}× · {formatNumber(deep.messages)} msgs</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
