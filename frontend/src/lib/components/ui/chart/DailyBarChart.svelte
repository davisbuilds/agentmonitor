<script lang="ts">
  // One bar per day, stacked by segment (bottom first), on a round-tick y axis
  // with faint gridlines. Each day is a button: its accessible name is `label`,
  // hovering or focusing it shows the tooltip, and clicking it selects the day.
  // HTML bars rather than SVG so the strip stretches to any width while its
  // labels keep their size. See docs/system/DESIGN.md.
  import type { Snippet } from 'svelte';
  import { dailyBarLayout, shortDate, type DailyBar } from './daily-bars';

  interface Props {
    days: DailyBar[];
    /** The day's accessible name, and the tooltip when no `tooltip` snippet is given. */
    label: (day: DailyBar) => string;
    onSelect?: (date: string) => void;
    formatTick?: (value: number) => string;
    /** Whole-number ticks, for counts. */
    integer?: boolean;
    /** Height of the plot area. */
    plotClass?: string;
    /** Width of the y-axis label column. */
    axisClass?: string;
    tooltip?: Snippet<[DailyBar]>;
    class?: string;
  }

  let {
    days,
    label,
    onSelect,
    formatTick = (value) => String(value),
    integer = false,
    plotClass = 'h-36',
    axisClass = 'w-8',
    tooltip,
    class: klass = '',
  }: Props = $props();

  const layout = $derived(dailyBarLayout(days, { integer }));
  const tooltipId = `daily-bar-tip-${Math.random().toString(36).slice(2)}`;
  let active = $state<number | null>(null);
  const activeColumn = $derived(active === null ? null : layout.columns[active] ?? null);
  // Open the tooltip from the plot's top edge beside the bar, away from the
  // nearer side, so a long list stays inside the card rather than above it.
  const activeLeftPct = $derived(active === null || layout.columns.length === 0 ? 0 : ((active + 0.5) / layout.columns.length) * 100);
</script>

<div class="flex min-h-0 flex-col {klass}">
  <div class="flex min-h-0 flex-1 gap-2">
    <div class="relative {axisClass} {plotClass} shrink-0 text-right tabular font-mono text-meta text-text-faint" aria-hidden="true">
      {#each layout.ticks as tick}
        <span class="absolute right-0 translate-y-1/2 leading-none" style={`bottom:${layout.top > 0 ? (tick / layout.top) * 100 : 0}%`}>{formatTick(tick)}</span>
      {/each}
    </div>

    <div class="relative {plotClass} min-w-0 flex-1 border-b border-line">
      {#each layout.ticks.slice(1) as tick}
        <div class="pointer-events-none absolute inset-x-0 border-t border-line/50" style={`bottom:${(tick / layout.top) * 100}%`} aria-hidden="true"></div>
      {/each}

      <div class="relative flex h-full items-end gap-[2px]">
        {#each layout.columns as column, index}
          <button
            class="group flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
            aria-label={label(column.day)}
            aria-describedby={active === index ? tooltipId : undefined}
            onmouseenter={() => (active = index)}
            onmouseleave={() => (active = null)}
            onfocus={() => (active = index)}
            onblur={() => (active = null)}
            onclick={() => onSelect?.(column.date)}
          >
            {#if column.total > 0}
              <!-- At least 2px, so a quiet day still reads as active; a 2px gap between segments. -->
              <span
                class="flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                style={`height:max(${column.heightPct}%, 2px)`}
                aria-hidden="true"
              >
                {#each column.segments as segment}
                  <span class="block w-full" style={`flex:${segment.value} 1 0;min-height:2px;background:${segment.color}`}></span>
                {/each}
              </span>
            {/if}
          </button>
        {/each}
      </div>

      {#if activeColumn}
        <div
          id={tooltipId}
          role="tooltip"
          class="pointer-events-none absolute top-1 z-20 min-w-48 max-w-72 rounded-lg border border-line bg-surface px-3 py-2 text-meta shadow-overlay"
          style={activeLeftPct > 50 ? `right:${100 - activeLeftPct}%` : `left:${activeLeftPct}%`}
        >
          {#if tooltip}
            {@render tooltip(activeColumn.day)}
          {:else}
            <span class="tabular font-mono text-text">{label(activeColumn.day)}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="flex gap-2 pt-1.5" aria-hidden="true">
    <div class="{axisClass} shrink-0"></div>
    <div class="flex min-w-0 flex-1 gap-[2px]">
      {#each layout.columns as column, index}
        <!-- The end labels align to the plot's edges, so neither overflows the card. -->
        <span class="min-w-0 flex-1 overflow-visible whitespace-nowrap text-meta tabular font-mono text-text-faint
          {index === 0 ? 'text-left' : index === layout.columns.length - 1 ? 'flex justify-end' : 'text-center'}">
          {layout.dateTicks.has(index) ? shortDate(column.date) : ''}
        </span>
      {/each}
    </div>
  </div>
</div>
