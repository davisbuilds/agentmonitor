<script lang="ts">
  import { InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { formatDateOnly, formatNumber } from '../../format';
  import type { SkillUsageDay } from '../../api/client';
  import { skillSeries, stackDay } from '../../skill-series';
  import { OTHER_COLOR, OTHER_LABEL } from '../usage/model-colors';

  type TooltipState = {
    day: SkillUsageDay;
    x: number;
    y: number;
  };

  let tooltip = $state<TooltipState | null>(null);

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

  // The tooltip is min-w-56 (224px); flip it left of the pointer near the right
  // edge so its counts stay inside the viewport.
  const TOOLTIP_WIDTH = 240;

  function placeTooltip(event: MouseEvent, day: SkillUsageDay): void {
    const right = event.clientX + 12 + TOOLTIP_WIDTH > window.innerWidth;
    tooltip = {
      day,
      x: right ? Math.max(event.clientX - 12 - TOOLTIP_WIDTH, 0) : event.clientX + 12,
      y: event.clientY - 12,
    };
  }

  function showTooltip(event: MouseEvent, day: SkillUsageDay): void {
    if (day.total === 0) return;
    placeTooltip(event, day);
  }

  function moveTooltip(event: MouseEvent, day: SkillUsageDay): void {
    if (day.total === 0 || !tooltip) return;
    placeTooltip(event, day);
  }

  const dayMap = $derived.by(() => new Map(analytics.skillUsageDaily.map((day) => [day.date, day])));

  const days = $derived.by(() => {
    const range = enumerateDays(analytics.from, analytics.to);
    return range.map((date) => dayMap.get(date) ?? { date, total: 0, skills: [] });
  });

  const maxTotal = $derived.by(() => Math.max(...days.map((day) => day.total), 1));

  // The range's top skills keep one palette color each; the rest fold into Other.
  const series = $derived(skillSeries(analytics.skillUsageDaily));
  const hasOther = $derived(analytics.skillUsageDaily.some(day => day.skills.some(skill => !series.top.includes(skill.skill_name))));
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <div class="flex items-center gap-1.5">
        <h3 class="text-h3">Raw skill invocation volume</h3>
        <InfoTip label="Raw skill invocation volume"><p>Claude counts explicit Skill tool calls; Codex counts reads of a skill's SKILL.md. Whether a skill was actually followed is in the consultation evidence below.</p></InfoTip>
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
      <div class="flex gap-2">
        <!-- The axis names the busiest day's invocations at the top and zero at the baseline. -->
        <div class="flex h-40 w-8 shrink-0 flex-col justify-between text-right tabular font-mono text-meta text-text-faint" aria-hidden="true">
          <span>{formatNumber(maxTotal)}</span>
          <span>0</span>
        </div>
        <div class="flex h-40 min-w-0 flex-1 items-end gap-px border-b border-line">
          {#each days as day}
            <button
              class="relative flex h-full flex-1 items-end rounded-t-sm transition-colors hover:bg-surface-2"
              title={`${formatDateOnly(day.date)}: ${day.total} skill invocation${day.total === 1 ? '' : 's'}`}
              onmouseenter={(event) => showTooltip(event, day)}
              onmousemove={(event) => moveTooltip(event, day)}
              onmouseleave={() => (tooltip = null)}
            >
              {#if day.total > 0}
                <div
                  class="absolute inset-x-0 bottom-0 overflow-hidden rounded-t-sm"
                  style={`height:max(${(day.total / maxTotal) * 100}%, 2px)`}
                >
                  <!-- A 2px gap between segments, so neighbors never fuse into one block. -->
                  <div class="flex h-full w-full flex-col-reverse gap-[2px]">
                    {#each stackDay(day, series.top, series.colors) as segment}
                      <div style={`flex:${segment.count} 1 0;min-height:1px;background:${segment.color}`}></div>
                    {/each}
                  </div>
                </div>
              {/if}
              <span class="sr-only">{day.date}</span>
            </button>
          {/each}
        </div>
      </div>

      <div class="ml-10 flex justify-between tabular font-mono text-meta text-text-faint">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>

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

      {#if tooltip}
        <div
          class="pointer-events-none fixed z-20 min-w-56 rounded-lg border border-line bg-surface px-3 py-2 shadow-overlay"
          style={`left:${tooltip.x}px;top:${tooltip.y}px`}
        >
          <div class="mb-2 text-body font-medium text-text">{formatDateOnly(tooltip.day.date)}</div>
          <div class="space-y-1 text-meta">
            {#each tooltip.day.skills as skill}
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2 text-text-muted">
                  <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background:${series.colors.get(skill.skill_name) ?? OTHER_COLOR}`}></span>
                  <span class="truncate">{skill.skill_name}</span>
                </div>
                <span class="shrink-0 tabular font-mono text-text">{formatNumber(skill.count)}</span>
              </div>
            {/each}
          </div>
          <div class="mt-2 border-t border-line pt-2 text-right tabular font-mono text-meta text-text-muted">
            Total {formatNumber(tooltip.day.total)}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No skill usage in the selected range.</div>
  {/if}
</section>
