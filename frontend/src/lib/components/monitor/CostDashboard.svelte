<script lang="ts">
  import { getCostData } from '../../stores/monitor.svelte';
  import { getCostWindow, setCostWindow } from '../../stores/monitor.svelte';
  import { COST_WINDOW_OPTIONS, formatMonitorCost, shortModelName, type CostWindow } from '../../monitor-analytics';
  import { Panel, SubTabs, Stat, Bar } from '../ui';

  interface Props {
    onwindowchange: () => void;
  }

  let { onwindowchange }: Props = $props();

  const costData = $derived(getCostData());
  const costWindow = $derived(getCostWindow());

  const totalCost = $derived.by(() => {
    if (!costData) return 0;
    return costData.by_model.reduce((sum, m) => sum + m.cost, 0);
  });
  const maxModelCost = $derived.by(() => Math.max(...(costData?.by_model || []).map((item) => item.cost), 0.01));
  const maxProjectCost = $derived.by(() => Math.max(...(costData?.by_project || []).map((item) => item.cost), 0.01));
  const maxTimelineCost = $derived.by(() => Math.max(...(costData?.timeline || []).map((item) => item.cost), 0.001));
  const timelinePoints = $derived.by(() => {
    if (!costData || costData.timeline.length < 2) return '';
    return costData.timeline
      .map((bucket, index) => {
        const x = (index / Math.max(costData.timeline.length - 1, 1)) * 100;
        const y = 100 - ((bucket.cost / maxTimelineCost) * 100);
        return `${x},${y}`;
      })
      .join(' ');
  });

  function handleWindowChange(nextWindow: CostWindow): void {
    if (nextWindow === costWindow) return;
    setCostWindow(nextWindow);
    onwindowchange();
  }
</script>

<Panel title="Cost Overview">
  {#snippet actions()}
    <SubTabs
      tabs={COST_WINDOW_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
      active={costWindow}
      onchange={(id) => handleWindowChange(id as CostWindow)}
    />
  {/snippet}

  {#if costData}
    <Stat
      label="Total Cost"
      value={formatMonitorCost(totalCost)}
      size="lg"
      sub={`Rolling window: ${costWindow === 'all' ? 'all time' : costWindow}`}
    />

    <div class="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 border-t border-line pt-5 md:grid-cols-2">
      <!-- By Model -->
      <div>
        <div class="mb-2 text-meta text-text-muted">By Model</div>
        {#if costData.by_model.length > 0}
          <div class="space-y-2.5">
            {#each costData.by_model.slice(0, 5) as item}
              <div>
                <div class="flex justify-between text-meta">
                  <span class="mr-2 truncate text-text">{shortModelName(item.model)}</span>
                  <span class="tabular shrink-0 font-mono text-text">{formatMonitorCost(item.cost)}</span>
                </div>
                <Bar value={item.cost} max={maxModelCost} tone="accent" class="mt-1" />
              </div>
            {/each}
          </div>
        {:else}
          <div class="text-meta text-text-faint">No data</div>
        {/if}
      </div>

      <!-- By Project -->
      <div>
        <div class="mb-2 text-meta text-text-muted">By Project</div>
        {#if costData.by_project.length > 0}
          <div class="space-y-2.5">
            {#each costData.by_project.slice(0, 5) as item}
              <div>
                <div class="flex justify-between text-meta">
                  <span class="mr-2 truncate text-text">{item.project}</span>
                  <span class="tabular shrink-0 font-mono text-text">{formatMonitorCost(item.cost)}</span>
                </div>
                <Bar value={item.cost} max={maxProjectCost} tone="accent" class="mt-1" />
                <div class="mt-1 text-meta text-text-faint">
                  {item.session_count} session{item.session_count === 1 ? '' : 's'}
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="text-meta text-text-faint">No data</div>
        {/if}
      </div>
    </div>

    {#if costData.timeline.length > 1}
      <div class="mt-6 border-t border-line pt-5">
        <div class="mb-3 flex items-center justify-between">
          <div class="text-meta text-text-muted">Spend Over Time</div>
          <div class="text-meta text-text-faint">
            {costData.timeline[0]?.date} to {costData.timeline[costData.timeline.length - 1]?.date}
          </div>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="h-28 w-full overflow-visible">
          <polyline
            fill="none"
            stroke="var(--color-accent)"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            points={timelinePoints}
          />
        </svg>
      </div>
    {/if}
  {:else}
    <div class="py-8 text-center text-meta text-text-muted">Loading cost data…</div>
  {/if}
</Panel>
