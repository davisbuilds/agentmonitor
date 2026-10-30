<script lang="ts">
  import { InfoTip } from '../ui';
  import { DailyBarChart, type DailyBar } from '../ui/chart';
  import { analytics } from '../../stores/analytics.svelte';
  import { formatDateOnly, formatNumber } from '../../format';
  import { skillSeries, stackDay } from '../../skill-series';
  import { OTHER_COLOR, OTHER_LABEL } from '../usage/model-colors';

  function enumerateDays(from: string, to: string): string[] {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return [];
    }

    const dates: string[] = [];
    for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
      dates.push(new Date(cursor).toISOString().slice(0, 10));
    }
    return dates;
  }

  const dayMap = $derived.by(() => new Map(analytics.skillUsageDaily.map((day) => [day.date, day])));

  // The range's top skills keep one palette color each; the rest fold into Other.
  const series = $derived(skillSeries(analytics.skillUsageDaily));
  const hasOther = $derived(analytics.skillUsageDaily.some(day => day.skills.some(skill => !series.top.includes(skill.skill_name))));

  const days = $derived.by((): DailyBar[] =>
    enumerateDays(analytics.from, analytics.to).map((date) => {
      const day = dayMap.get(date) ?? { date, total: 0, skills: [] };
      return {
        date,
        segments: stackDay(day, series.top, series.colors).map(segment => ({ key: segment.name, value: segment.count, color: segment.color })),
      };
    }),
  );

  function label(day: DailyBar): string {
    const total = dayMap.get(day.date)?.total ?? 0;
    return `${formatDateOnly(day.date)}: ${formatNumber(total)} skill invocation${total === 1 ? '' : 's'}`;
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <div class="flex items-center gap-1.5">
        <h3 class="text-h3">Raw skill invocation volume</h3>
        <InfoTip label="Raw skill invocation volume"><p>Claude counts explicit Skill tool calls; Codex counts reads of a skill's SKILL.md. Whether a skill was actually followed is in the consultation evidence below. Point at a day for its skills; click it to narrow the page to that day.</p></InfoTip>
      </div>
    </div>
    {#if analytics.coverage.skills}
      <span class="tabular font-mono text-meta text-text-faint">{analytics.coverage.skills.included_sessions} sessions in range</span>
    {/if}
  </div>

  {#if analytics.loading.skills}
    <div class="py-12 text-center text-meta text-text-muted">Loading skill analytics…</div>
  {:else if analytics.errors.skills}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.skills}</div>
  {:else if analytics.skillUsageDaily.length > 0}
    <div class="space-y-3">
      <DailyBarChart {days} {label} integer formatTick={formatNumber} plotClass="h-40" onSelect={(date) => analytics.drillDownToDay(date)}>
        {#snippet tooltip(bar)}
          {@const day = dayMap.get(bar.date)}
          <div class="mb-2 text-body font-medium text-text">{formatDateOnly(bar.date)}</div>
          {#if day && day.total > 0}
            <div class="space-y-1">
              {#each day.skills as skill}
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-2 text-text-muted">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background:${series.colors.get(skill.skill_name) ?? OTHER_COLOR}`}></span>
                    <span class="truncate">{skill.skill_name}</span>
                  </div>
                  <span class="shrink-0 tabular font-mono text-text">{formatNumber(skill.count)}</span>
                </div>
              {/each}
            </div>
            <div class="mt-2 border-t border-line pt-2 text-right tabular font-mono text-text-muted">Total {formatNumber(day.total)}</div>
          {:else}
            <div class="text-text-muted">No skill invocations</div>
          {/if}
        {/snippet}
      </DailyBarChart>

      {#if series.top.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each series.top as skillName}
            <div class="inline-flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-meta text-text-muted">
              <span class="h-2 w-2 rounded-full" style={`background:${series.colors.get(skillName)}`}></span>
              <span>{skillName}</span>
            </div>
          {/each}
          {#if hasOther}
            <div class="inline-flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-meta text-text-muted">
              <span class="h-2 w-2 rounded-full" style={`background:${OTHER_COLOR}`}></span>
              <span>{OTHER_LABEL}</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No skill usage in the selected range.</div>
  {/if}
</section>
