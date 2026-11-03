<script lang="ts">
  // The key to the change markers on the Overview timelines, and the reason
  // instruction changes are missing until a project is selected.
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const markers = $derived(analytics.changeMarkers?.markers ?? []);
  const models = $derived(markers.filter(marker => marker.kind === 'model').length);
  const instructions = $derived(markers.filter(marker => marker.kind === 'instructions').length);
  const projectSelected = $derived(analytics.project !== '');
</script>

{#if models > 0 || instructions > 0}
  <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-muted">
    {#if models > 0}
      <span class="flex items-center gap-1.5">
        <span class="block h-[7px] w-[7px] rotate-45 rounded-[1px] bg-text-muted" aria-hidden="true"></span>
        Model taken up
      </span>
    {/if}
    {#if projectSelected && instructions > 0}
      <span class="flex items-center gap-1.5">
        <span class="block h-[7px] w-[7px] rounded-[1px] bg-text-muted" aria-hidden="true"></span>
        Instructions changed
      </span>
    {:else if instructions > 0}
      <span class="text-text-faint">
        {formatNumber(instructions)} instruction change{instructions === 1 ? '' : 's'} across projects; select a project to mark its own.
      </span>
    {/if}
  </div>
{/if}
