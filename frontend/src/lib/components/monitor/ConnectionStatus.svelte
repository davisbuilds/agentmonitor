<script lang="ts">
  import { getConnectionStatus } from '../../stores/monitor.svelte';

  const status = $derived(getConnectionStatus());
  const dotClass = $derived(
    status === 'connected' ? 'bg-green-400' :
    status === 'connecting' ? 'bg-yellow-400' :
    'bg-red-400'
  );
  const label = $derived(
    status === 'connected' ? 'Connected' :
    status === 'connecting' ? 'Connecting' :
    'Disconnected'
  );

  let showTooltip = $state(false);
</script>

<button
  type="button"
  class="relative inline-flex h-3 w-3 cursor-default items-center justify-center"
  aria-label={label}
  onmouseenter={() => showTooltip = true}
  onmouseleave={() => showTooltip = false}
  onfocus={() => showTooltip = true}
  onblur={() => showTooltip = false}
>
  <span class="h-2.5 w-2.5 rounded-full {dotClass}"></span>
  {#if showTooltip}
    <span class="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200 shadow-lg">
      {label}
    </span>
  {/if}
</button>
