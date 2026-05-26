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

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Skills</h3>
      <p class="mt-0.5 text-meta text-text-muted">Claude uses explicit `Skill` calls. Codex is inferred from `SKILL.md` reads in OTEL or JSONL fallback.</p>
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
      <div class="flex items-center justify-between tabular font-mono text-meta text-text-faint">
        <span>0</span>
        <span>{formatNumber(maxTotal)}</span>
      </div>

      <div class="flex h-40 items-end gap-1">
        {#each days as day}
          <button
            class="relative flex h-full flex-1 items-end rounded-t-sm bg-surface-2 transition-colors hover:bg-line"
            title={`${formatDayLabel(day.date)}: ${day.total} skill invocation${day.total === 1 ? '' : 's'}`}
            onmouseenter={(event) => showTooltip(event, day)}
            onmousemove={(event) => moveTooltip(event, day)}
            onmouseleave={() => (tooltip = null)}
          >
            {#if day.total > 0}
              <div
                class="absolute inset-x-0 bottom-0 overflow-hidden rounded-t-sm"
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

      <div class="flex justify-between tabular font-mono text-meta text-text-faint">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>

      {#if legendSkills.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each legendSkills as skillName}
            <div class="inline-flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-meta text-text-muted">
              <span class="h-2 w-2 rounded-full" style={`background:${colorForSkill(skillName)}`}></span>
              <span>{skillName}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if tooltip}
        <div
          class="pointer-events-none fixed z-20 min-w-56 rounded-lg border border-line bg-surface px-3 py-2 shadow-overlay"
          style={`left:${tooltip.x}px;top:${tooltip.y}px`}
        >
          <div class="mb-2 text-body font-medium text-text">{formatDayLabel(tooltip.day.date)}</div>
          <div class="space-y-1 text-meta">
            {#each tooltip.day.skills as skill}
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2 text-text-muted">
                  <span class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background:${colorForSkill(skill.skill_name)}`}></span>
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
