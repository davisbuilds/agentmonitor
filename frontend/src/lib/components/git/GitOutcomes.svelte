<script lang="ts">
  import { Bar, InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { formatCost, formatNumber } from '../../format';
  import { coverageNotes, landedShare, OUTCOME_STYLE, outcomeParts, spendSegments, weekSeries } from '../../outcome-chart';
  import OutcomeTrend from './OutcomeTrend.svelte';

  const PROJECT_ROWS = 8;

  const data = $derived(analytics.outcomes);
  const parts = $derived(outcomeParts(data));
  const segments = $derived(spendSegments(data));
  const landed = $derived(landedShare(data));
  const notes = $derived(coverageNotes(data?.coverage ?? null));
  const merged = $derived(data?.merged_prs ?? null);
  const weeks = $derived((data?.weeks ?? []).map(week => week.week));
  const sizeMax = $derived(Math.max(0, ...(data?.sizes ?? []).map(size => size.median_usd ?? 0)));
  const projects = $derived((data?.projects ?? []).slice(0, PROJECT_ROWS));
  const color = OUTCOME_STYLE.merged_pr.color;

  function percent(share: number): string {
    if (share > 0 && share < 0.005) return '<1%';
    return `${Math.round(share * 100)}%`;
  }
  const dollars = (value: number) => formatCost(value);
  const tokens = (value: number) => formatNumber(Math.round(value));
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="git-outcomes-heading">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 id="git-outcomes-heading" class="text-h3">Cost per Outcome</h3>
    <InfoTip label="Cost per Outcome" width="w-96">
      <p>Inferred, not recorded. Each minute of spend goes to the next thing its session produced: a commit, or a pull request it opened. That is then followed to whether it landed on a main branch, merged as a pull request or pushed straight to it.</p>
      <p class="mt-2">A merged pull request costs the spend that led to it, including work in the month before the range. "Nothing after it" is not waste: it is work no commit followed, such as questions, reviews or planning. Costs are API-rate estimates, as Usage counts them, and landing reflects each repository's last fetch.</p>
    </InfoTip>
  </div>

  {#if analytics.loading.outcomes && !data}
    <div class="py-12 text-center text-meta text-text-muted">Loading cost per outcome…</div>
  {:else if analytics.errors.outcomes}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.outcomes}</div>
  {:else if !data || (!parts.spend && !parts.merged)}
    <div class="py-12 text-center text-meta text-text-muted">No spend in the selected range.</div>
  {:else}
    <div class="mb-4 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-meta text-text-muted" role="group" aria-label="Cost per outcome headlines">
      {#if merged && parts.merged}
        <span>
          <span class="tabular font-mono text-h2 text-text">{formatCost(merged.median_usd)}</span>
          median per merged pull request
          <span class="tabular font-mono">({formatCost(merged.p25_usd)}–{formatCost(merged.p75_usd)})</span>
        </span>
        {#if parts.spend}
          <span>
            <span class="tabular font-mono text-h2 text-text">{formatCost(merged.all_in_usd)}</span>
            all spend over {formatNumber(merged.prs)} merged
          </span>
        {/if}
      {:else}
        <span>No pull request merged in the selected range.</span>
      {/if}
      {#if landed !== null}
        <span>
          <span class="tabular font-mono text-h2 text-text">{percent(landed)}</span>
          of {formatCost(data.total_usd)} spent before work that landed
        </span>
      {/if}
    </div>

    {#if !parts.spend}
      <p class="text-meta text-text-muted" data-testid="outcome-no-spend">No spend in the selected range. The figures below count the work before each merge, up to a month earlier.</p>
    {:else}
      <h4 class="mb-2 text-meta text-text-muted">Where the spend went</h4>
      <div class="flex h-7 w-full gap-[2px] overflow-hidden rounded-sm" role="img"
        aria-label={segments.filter(s => s.share > 0).map(s => `${s.label} ${percent(s.share)}`).join(', ')}>
        {#each segments.filter(s => s.share > 0) as segment (segment.outcome)}
          <div class="flex min-w-[2px] items-center justify-center overflow-hidden text-meta text-text"
            style={`width:${segment.share * 100}%;background:${segment.color}`}
            title={`${segment.label}: ${formatCost(segment.usd)} (${percent(segment.share)})`}
            data-testid="outcome-segment">
            {#if segment.labelled}<span class="tabular truncate px-1 font-mono">{percent(segment.share)}</span>{/if}
          </div>
        {/each}
      </div>
      <ul class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-meta text-text-muted sm:grid-cols-2 xl:grid-cols-3" aria-label="Where the spend went">
        {#each segments as segment (segment.outcome)}
          <li class="flex items-center justify-between gap-3">
            <span class="flex items-center gap-1.5">
              <span class="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={`background:${segment.color}`} aria-hidden="true"></span>
              {segment.label}
            </span>
            <span class="tabular font-mono text-text">{formatCost(segment.usd)} <span class="text-text-muted">{percent(segment.share)}</span></span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if weeks.length > 0}
      <h4 class="mb-2 mt-6 text-meta text-text-muted">By week of merge</h4>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <OutcomeTrend title="Median per merged PR" points={weekSeries(data.weeks, 'median_usd')} {weeks} {color} format={dollars} />
        <OutcomeTrend title="Tokens per merged PR" points={weekSeries(data.weeks, 'median_tokens')} {weeks} {color} format={tokens} />
        <OutcomeTrend title="Dollars per million tokens" points={weekSeries(data.weeks, 'usd_per_mtok')} {weeks} {color} format={dollars} />
      </div>
      <details class="mt-2 text-meta text-text-muted">
        <summary class="cursor-pointer">Weekly figures</summary>
        <table class="mt-2 w-full">
          <thead>
            <tr class="border-b border-line text-left">
              <th class="py-1.5 font-medium">Week of</th>
              <th class="py-1.5 text-right font-medium">Merged</th>
              <th class="py-1.5 text-right font-medium">Median</th>
              <th class="py-1.5 text-right font-medium">Middle half</th>
              <th class="py-1.5 text-right font-medium">Tokens</th>
              <th class="py-1.5 text-right font-medium">Per million tokens</th>
            </tr>
          </thead>
          <tbody>
            {#each data.weeks as week (week.week)}
              <tr class="border-b border-line/50">
                <td class="py-1.5">{week.week}</td>
                <td class="tabular py-1.5 text-right font-mono">{week.prs}</td>
                <td class="tabular py-1.5 text-right font-mono">{week.median_usd === null ? '–' : formatCost(week.median_usd)}</td>
                <td class="tabular py-1.5 text-right font-mono">{week.p25_usd === null ? '–' : `${formatCost(week.p25_usd)}–${formatCost(week.p75_usd)}`}</td>
                <td class="tabular py-1.5 text-right font-mono">{week.median_tokens === null ? '–' : tokens(week.median_tokens)}</td>
                <td class="tabular py-1.5 text-right font-mono">{week.usd_per_mtok === null ? '–' : formatCost(week.usd_per_mtok)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </details>
    {/if}

    {#if parts.merged}
      <div class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div>
          <div class="mb-2 flex items-center gap-1.5">
            <h4 class="text-meta text-text-muted">Median by size</h4>
            <InfoTip label="Median by size">
              <p>Merged pull requests by lines changed (added plus removed), which GitHub gives with lookups on. Larger pull requests cost more, so a change in the weekly median can be a change in size.</p>
            </InfoTip>
          </div>
          <ul class="space-y-2" aria-label="Median cost by pull request size">
            {#each data.sizes as size (size.bucket)}
              <li class="grid grid-cols-[6rem_1fr_7rem] items-center gap-3 text-meta">
                <span class="text-text-muted">{size.bucket} lines</span>
                <Bar value={size.median_usd ?? 0} max={sizeMax} />
                <span class="tabular text-right font-mono text-text">{size.median_usd === null ? '–' : formatCost(size.median_usd)} <span class="text-text-muted">({size.prs})</span></span>
              </li>
            {/each}
          </ul>
          {#if data.unknown_size > 0}
            <p class="mt-2 text-meta text-text-faint">{formatNumber(data.unknown_size)} merged pull request{data.unknown_size === 1 ? ' has' : 's have'} no size from GitHub.</p>
          {/if}
        </div>
        <div>
          <div class="mb-2 flex items-center gap-1.5">
            <h4 class="text-meta text-text-muted">By project</h4>
            <InfoTip label="By project">
              <p>"Typical" pulls each project's figure toward the overall one, further the fewer pull requests it has: cost varies far more between pull requests than between projects, so a project's median on a few is mostly chance.</p>
            </InfoTip>
          </div>
          <table class="w-full text-meta">
            <thead>
              <tr class="border-b border-line text-left text-text-muted">
                <th class="py-1.5 font-medium">Project</th>
                <th class="py-1.5 text-right font-medium">Merged</th>
                <th class="py-1.5 text-right font-medium">Median</th>
                <th class="py-1.5 text-right font-medium">Typical</th>
              </tr>
            </thead>
            <tbody>
              {#each projects as project (project.project)}
                <tr class="border-b border-line/50">
                  <td class="max-w-0 truncate py-1.5 text-text" title={project.project}>{project.project}</td>
                  <td class="tabular py-1.5 text-right font-mono text-text-muted">{project.prs}</td>
                  <td class="tabular py-1.5 text-right font-mono text-text-muted">{formatCost(project.median_usd)}</td>
                  <td class="tabular py-1.5 text-right font-mono text-text">{formatCost(project.pooled_usd)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    {#if notes.length > 0}
      <div class="mt-4 space-y-1 text-meta text-text-faint" data-testid="outcome-coverage">
        {#each notes as note (note)}<p class="max-w-[65ch]">{note}</p>{/each}
      </div>
    {/if}
  {/if}
</section>
