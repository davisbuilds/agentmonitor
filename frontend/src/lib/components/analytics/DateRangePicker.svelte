<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';

  let from = $state(analytics.from);
  let to = $state(analytics.to);

  $effect(() => {
    from = analytics.from;
    to = analytics.to;
  });

  async function applyRange() {
    await analytics.setDateRange(from, to);
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  <label class="text-xs text-gray-500">
    <span class="sr-only">From</span>
    <input
      type="date"
      class="bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5"
      bind:value={from}
      onchange={applyRange}
    />
  </label>
  <span class="text-xs text-gray-600">to</span>
  <label class="text-xs text-gray-500">
    <span class="sr-only">To</span>
    <input
      type="date"
      class="bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5"
      bind:value={to}
      onchange={applyRange}
    />
  </label>

  <div class="flex items-center gap-1">
    <button class="text-xs rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => analytics.applyQuickRange(7)}>7D</button>
    <button class="text-xs rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => analytics.applyQuickRange(30)}>30D</button>
    <button class="text-xs rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => analytics.applyQuickRange(90)}>90D</button>
    <button class="text-xs rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => analytics.clearDateRange()}>Reset</button>
  </div>
</div>
