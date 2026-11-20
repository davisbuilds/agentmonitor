<script lang="ts">
  import { InfoTip } from '../ui';
  import { DailyBarChart, type DailyBar } from '../ui/chart';
  import { analytics } from '../../stores/analytics.svelte';
  import { agentHexColor, agentName, formatNumber } from '../../format';
  import { gitBars, OUTSIDE_COLOR } from '../../git-activity-bars';

  const data = $derived(analytics.gitActivity);
  const chart = $derived(gitBars(data));
  const opened = $derived((data?.agents ?? []).reduce((sum, row) => sum + row.prs_opened, 0));
  const merged = $derived((data?.agents ?? []).reduce((sum, row) => sum + row.prs_merged, 0));
  const coverage = $derived(data?.coverage ?? null);
  const scopes = [
    { id: 'mine', label: 'My work' },
    { id: 'all', label: 'All contributors' },
  ] as const;

  function label(day: DailyBar): string {
    const split = chart.byDate.get(day.date);
    if (!split) return day.date;
    const parts = chart.agents.map(agent => `${formatNumber(split.by_agent[agent] ?? 0)} ${agentName(agent)}`);
    return `${day.date}: ${[...parts, `${formatNumber(split.outside)} outside a session`].join(', ')}`;
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="git-commits-heading">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1.5">
      <h3 id="git-commits-heading" class="text-h3">Commits</h3>
      <InfoTip label="Commits">
        <p>My work includes commits authored with your Git email and commits a monitored session proved it created. All contributors includes every author in the tracked repositories. The chart excludes merge commits. Click a day to narrow the page to it.</p>
      </InfoTip>
    </div>
    <div class="flex shrink-0 rounded-sm border border-line" role="group" aria-label="Commit scope">
      {#each scopes as scope (scope.id)}
        <button
          type="button"
          class="px-2 py-1 text-meta transition-colors first:rounded-l-sm last:rounded-r-sm
            {analytics.gitCommitScope === scope.id ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text'}"
          aria-pressed={analytics.gitCommitScope === scope.id}
          onclick={() => analytics.setGitCommitScope(scope.id)}
        >{scope.label}</button>
      {/each}
    </div>
  </div>

  {#if data?.author_identity_configured === false}
    <p class="mb-3 text-meta text-text-muted">My work shows proven session commits. Set a Git author email to include your other commits.</p>
  {/if}

  {#if analytics.loading.git && !data}
    <div class="py-12 text-center text-meta text-text-muted">Loading commits…</div>
  {:else if analytics.errors.git}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.git}</div>
  {:else if !data || chart.agentCommits + chart.outside === 0}
    <div class="py-12 text-center text-meta text-text-muted">No commits in the selected range.</div>
  {:else}
    <div class="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-meta text-text-muted">
      <span>
        <span class="tabular font-mono text-h3 text-text">{formatNumber(chart.agentCommits)}</span>
        of {formatNumber(chart.agentCommits + chart.outside)} commit{chart.agentCommits + chart.outside === 1 ? '' : 's'} by agents
      </span>
      <span>
        <span class="tabular font-mono text-h3 text-text">{formatNumber(opened)}</span>
        pull request{opened === 1 ? '' : 's'} opened, <span class="tabular font-mono text-text">{formatNumber(merged)}</span> merged
      </span>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-muted">
      {#each chart.agents as agent (agent)}
        <span class="flex items-center gap-1.5">
          <span class="h-2.5 w-2.5 rounded-[2px]" style={`background:${agentHexColor(agent)}`} aria-hidden="true"></span>
          {agentName(agent)}
        </span>
      {/each}
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-[2px]" style={`background:${OUTSIDE_COLOR}`} aria-hidden="true"></span>
        Outside a session
      </span>
    </div>

    <DailyBarChart days={chart.days} {label} integer onSelect={(date) => analytics.drillDownToDay(date)}>
      {#snippet tooltip(bar)}
        {@const split = chart.byDate.get(bar.date)}
        <div class="mb-2 text-body font-medium text-text">{bar.date}</div>
        {#if split}
          <div class="space-y-1">
            {#each [
              ...chart.agents.map(agent => ({ key: agentName(agent), value: split.by_agent[agent] ?? 0, color: agentHexColor(agent) })),
              { key: 'Outside a session', value: split.outside, color: OUTSIDE_COLOR },
            ] as row (row.key)}
              <div class="flex items-center justify-between gap-3">
                <span class="flex items-center gap-2 text-text-muted">
                  <span class="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={`background:${row.color}`}></span>
                  {row.key}
                </span>
                <span class="tabular font-mono text-text">{formatNumber(row.value)}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/snippet}
    </DailyBarChart>

    {#if coverage && coverage.commits > coverage.proven}
      <p class="mt-3 text-meta text-text-faint">
        {#if coverage.time_only > 0}{formatNumber(coverage.time_only)} outside commit{coverage.time_only === 1 ? ' was' : 's were'} made within two minutes of a session's commit without proof it was the session's.{/if}
        {#if coverage.trailer_without_session > 0}{formatNumber(coverage.trailer_without_session)} carr{coverage.trailer_without_session === 1 ? 'ies' : 'y'} a Claude co-author trailer with no session here to prove it, such as from another machine.{/if}
      </p>
    {/if}
  {/if}
</section>
