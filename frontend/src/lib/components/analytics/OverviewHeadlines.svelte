<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { agentName, formatCost, formatDateRange, formatNumber } from '../../format';
  import { formatHours, formatRate, percentChange, pointChange, type ChangeLabel } from '../../overview-headlines';
  import { InfoTip } from '../ui';
  import { Sparkline } from '../ui/chart';

  const headlines = $derived(analytics.headlines);
  const days = $derived(headlines?.days.length ?? 0);
  const transcriptGap = $derived(
    headlines ? headlines.cost.usage_sessions - headlines.cost.sessions_with_transcript : 0,
  );

  const toneClass: Record<ChangeLabel['tone'], string> = {
    ok: 'text-ok',
    danger: 'text-danger',
    muted: 'text-text-faint',
  };

  const agentColor: Record<string, string> = {
    claude: 'var(--color-claude)',
    codex: 'var(--color-codex)',
    antigravity: 'var(--color-antigravity)',
  };
</script>

{#snippet change(label: ChangeLabel | null)}
  {#if label}<span class="text-meta {toneClass[label.tone]}">{label.value}</span>{/if}
{/snippet}

{#if analytics.errors.headlines}
  <div class="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-meta text-danger">
    {analytics.errors.headlines}
  </div>
{:else if analytics.loading.headlines && !headlines}
  <div class="h-36 animate-pulse rounded-lg border border-line bg-surface"></div>
{:else if headlines}
  <section
    class="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-5"
    aria-label="Overview headlines"
  >
    <div class="flex flex-col gap-1 bg-surface p-4" data-testid="headline-cost">
      <div class="text-meta text-text-muted">Cost</div>
      <div class="flex items-baseline gap-2">
        <span class="tabular font-mono text-h2 text-text">{formatCost(headlines.cost.value)}</span>
        {@render change(percentChange(headlines.cost.value, headlines.cost.prior, 'up-is-bad'))}
      </div>
      <!-- Name the window, so this figure can't be read against Monitor's. -->
      <div class="text-meta text-text-faint">
        {formatDateRange(analytics.from, analytics.to)}{#if headlines.cost.prior !== null} · vs {formatCost(headlines.cost.prior)} before{/if}
      </div>
      {#if headlines.cost.per_session_usd !== null}
        <div class="text-meta text-text-faint">
          {formatCost(headlines.cost.per_session_usd)} per session{#if transcriptGap > 0}, over {formatNumber(headlines.cost.sessions_with_transcript)} of {formatNumber(headlines.cost.usage_sessions)} with a transcript{/if}
        </div>
      {/if}
      <Sparkline class="mt-auto h-7 pt-2" values={headlines.cost.daily} />
    </div>

    <div class="flex flex-col gap-1 bg-surface p-4" data-testid="headline-prompts">
      <div class="flex items-center gap-1.5 text-meta text-text-muted">
        Prompts
        <InfoTip label="Prompts"><p>Messages you sent. Tool results the agent reads back are not prompts.</p></InfoTip>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular font-mono text-h2 text-text">{formatNumber(headlines.prompts.value)}</span>
        {@render change(percentChange(headlines.prompts.value, headlines.prompts.prior))}
      </div>
      {#if headlines.prompts.prior !== null}
        <div class="text-meta text-text-faint">vs {formatNumber(headlines.prompts.prior)} the period before</div>
      {/if}
      <Sparkline class="mt-auto h-7 pt-2" values={headlines.prompts.daily} />
    </div>

    <div class="flex flex-col gap-1 bg-surface p-4" data-testid="headline-sessions">
      <div class="flex items-center gap-1.5 text-meta text-text-muted">
        Sessions
        <InfoTip label="Sessions"><p>Sessions you started. Delegated work, subagents and Codex app jobs, is not a session of its own; the second line is its share of the range's sessions.</p></InfoTip>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular font-mono text-h2 text-text">{formatNumber(headlines.sessions.value)}</span>
        {@render change(percentChange(headlines.sessions.value, headlines.sessions.prior))}
      </div>
      <Sparkline class="mt-auto h-7 pt-2" values={headlines.sessions.daily} />
      <!-- The delegated share gets its own labeled line, so the two trends never read as one. -->
      <div class="flex items-center gap-2 text-meta text-text-faint">
        <span class="shrink-0">{Math.round(headlines.sessions.delegated_share * 100)}% delegated</span>
        <Sparkline class="h-4 min-w-0 flex-1" color="var(--color-text-faint)" values={headlines.sessions.daily_delegated_share} />
      </div>
    </div>

    <div class="flex flex-col gap-1 bg-surface p-4" data-testid="headline-tool-errors">
      <div class="flex items-center gap-1.5 text-meta text-text-muted">
        Tool errors
        <InfoTip label="Tool errors"><p>The share of tool calls that failed, by each agent's own record: Claude Code's transcripts, Codex's telemetry. The two record failures differently, so they are never pooled. A Codex session without telemetry has no recorded outcomes.</p></InfoTip>
      </div>
      {#if headlines.tool_errors.length === 0}
        <div class="text-meta text-text-faint">No tool outcomes recorded.</div>
      {:else}
        <!-- No daily line: on most days a rate rests on a handful of calls, so its
             shape would be noise. The counts say how much each rate rests on. -->
        {#each headlines.tool_errors as row}
          <div>
            <div class="flex items-baseline gap-2">
              <span class="h-2 w-2 shrink-0 self-center rounded-full" style={`background:${agentColor[row.agent] ?? 'var(--color-accent)'}`} aria-hidden="true"></span>
              <span class="tabular font-mono text-h3 text-text">{formatRate(row.rate)}</span>
              <span class="text-meta text-text-muted">{agentName(row.agent)}</span>
              {@render change(pointChange(row.rate, row.prior_rate))}
            </div>
            <div class="pl-4 text-meta text-text-faint">{formatNumber(row.errors)} of {formatNumber(row.results)} calls failed</div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="flex flex-col gap-1 bg-surface p-4" data-testid="headline-active-hours">
      <div class="flex items-center gap-1.5 text-meta text-text-muted">
        Active hours
        <InfoTip label="Active hours"><p>Inferred from message times: the time agents were working, with any pause longer than 15 minutes counted as 15. Parallel sessions share one clock, so they add no extra time.</p></InfoTip>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular font-mono text-h2 text-text">{formatHours(headlines.active_hours.value)}</span>
        {@render change(percentChange(headlines.active_hours.value, headlines.active_hours.prior))}
      </div>
      {#if days > 0}
        <div class="text-meta text-text-faint">{formatHours(headlines.active_hours.value / days)} a day</div>
      {/if}
      <Sparkline class="mt-auto h-7 pt-2" values={headlines.active_hours.daily} />
    </div>
  </section>
{/if}
