<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';
  import type { SkillUsageDay } from '../../api/client';

  type TooltipState = {
    day: SkillUsageDay;
    x: number;
    y: number;
  };

  const palette = [
    '#60a5fa',
    '#fb7185',
    '#f59e0b',
    '#34d399',
    '#a78bfa',
    '#f472b6',
    '#38bdf8',
    '#f97316',
    '#22c55e',
    '#c084fc',
  ];

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

  function formatDayLabel(date: string): string {
    return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function colorForSkill(skillName: string): string {
    let hash = 0;
    for (let i = 0; i < skillName.length; i++) {
      hash = ((hash << 5) - hash + skillName.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length] ?? palette[0];
  }

  function showTooltip(event: MouseEvent, day: SkillUsageDay): void {
    if (day.total === 0) return;
    tooltip = {
      day,
      x: event.clientX + 12,
      y: event.clientY - 12,
    };
  }

  function moveTooltip(event: MouseEvent, day: SkillUsageDay): void {
    if (day.total === 0 || !tooltip) return;
    tooltip = {
      day,
      x: event.clientX + 12,
      y: event.clientY - 12,
    };
  }

  const dayMap = $derived.by(() => new Map(analytics.skillUsageDaily.map((day) => [day.date, day])));

  const days = $derived.by(() => {
    const range = enumerateDays(analytics.from, analytics.to);
    return range.map((date) => dayMap.get(date) ?? { date, total: 0, skills: [] });
  });

  const maxTotal = $derived.by(() => Math.max(...days.map((day) => day.total), 1));

  const legendSkills = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const day of analytics.skillUsageDaily) {
      for (const skill of day.skills) {
        totals.set(skill.skill_name, (totals.get(skill.skill_name) ?? 0) + skill.count);
      }
    }

    return [...totals.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([skill_name]) => skill_name);
  });
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Skills</h3>
      <p class="text-xs text-gray-500">Claude uses explicit `Skill` calls. Codex is inferred from `SKILL.md` reads in OTEL or JSONL fallback.</p>
    </div>
    {#if analytics.coverage.skills}
      <span class="text-xs text-gray-500">{analytics.coverage.skills.included_sessions} sessions in range</span>
    {/if}
  </div>

  {#if analytics.loading.skills}
    <div class="py-12 text-center text-sm text-gray-500">Loading skill analytics...</div>
  {:else if analytics.errors.skills}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.skills}</div>
  {:else if analytics.skillUsageDaily.length > 0}
    <div class="space-y-3">
      <div class="flex items-center justify-between text-[11px] text-gray-600">
        <span>0</span>
        <span>{formatNumber(maxTotal)}</span>
      </div>

      <div class="flex h-40 items-end gap-1">
        {#each days as day}
          <button
            class="group relative flex h-full flex-1 items-end rounded-t bg-gray-800/60 transition-colors hover:bg-gray-700/70"
            title={`${formatDayLabel(day.date)}: ${day.total} skill invocation${day.total === 1 ? '' : 's'}`}
            onmouseenter={(event) => showTooltip(event, day)}
            onmousemove={(event) => moveTooltip(event, day)}
            onmouseleave={() => (tooltip = null)}
          >
            {#if day.total > 0}
              <div
                class="absolute inset-x-0 bottom-0 overflow-hidden rounded-t"
                style={`height:${Math.max((day.total / maxTotal) * 100, 4)}%`}
              >
                <div class="flex h-full w-full flex-col-reverse">
                  {#each day.skills as skill}
                    <div
                      style={`height:${(skill.count / day.total) * 100}%;background:${colorForSkill(skill.skill_name)}`}
                    ></div>
                  {/each}
                </div>
              </div>
            {/if}
            <span class="sr-only">{day.date}</span>
          </button>
        {/each}
      </div>

      <div class="flex justify-between text-[11px] text-gray-600">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>

      {#if legendSkills.length > 0}
        <div class="flex flex-wrap gap-2">
          {#each legendSkills as skillName}
            <div class="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-gray-950/70 px-2 py-1 text-[11px] text-gray-300">
              <span class="h-2 w-2 rounded-full" style={`background:${colorForSkill(skillName)}`}></span>
              <span>{skillName}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if tooltip}
        <div
          class="pointer-events-none fixed z-20 min-w-56 rounded-xl border border-gray-700 bg-gray-950/95 px-3 py-2 shadow-2xl"
          style={`left:${tooltip.x}px;top:${tooltip.y}px`}
        >
          <div class="mb-2 text-sm font-semibold text-gray-100">{formatDayLabel(tooltip.day.date)}</div>
          <div class="space-y-1 text-sm">
            {#each tooltip.day.skills as skill}
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2 text-gray-300">
                  <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background:${colorForSkill(skill.skill_name)}`}></span>
                  <span class="truncate">{skill.skill_name}</span>
                </div>
                <span class="shrink-0 text-gray-100">{formatNumber(skill.count)}</span>
              </div>
            {/each}
          </div>
          <div class="mt-2 border-t border-gray-800 pt-2 text-right text-sm text-gray-300">
            Total {formatNumber(tooltip.day.total)}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No skill usage in the selected range.</div>
  {/if}
</section>
