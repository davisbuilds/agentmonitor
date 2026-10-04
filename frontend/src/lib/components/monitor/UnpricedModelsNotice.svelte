<script lang="ts">
  import { getUnpricedModels } from '../../stores/monitor.svelte';
  import { formatNumber } from '../../format';
  import { Popover } from '../ui';

  const models = $derived(getUnpricedModels());
</script>

{#if models.length > 0}
  <Popover align="right" width="w-80" label="Unpriced models">
    {#snippet trigger({ toggle, open })}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-sm border border-warn/40 px-2 py-1 text-meta text-warn transition-colors hover:border-warn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onclick={toggle}
        data-testid="unpriced-models-notice"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-warn"></span>
        {models.length === 1 ? 'Unpriced model' : `${models.length} unpriced models`}
      </button>
    {/snippet}
    <div class="space-y-2 text-meta">
      <p class="text-text">Usage from these models in the last week bills as $0: no rate card matches them.</p>
      <ul class="space-y-1">
        {#each models as entry (entry.model)}
          <li class="flex justify-between gap-3">
            <span class="font-mono text-text">{entry.model}</span>
            <span class="text-text-muted">{formatNumber(entry.usage_events)} event{entry.usage_events === 1 ? '' : 's'}</span>
          </li>
        {/each}
      </ul>
      <p class="text-text-muted">
        Cost totals leave them out until their rates are added under
        <code class="font-mono">src/pricing/data/</code> and <code class="font-mono">amon serve</code>
        restarts on the new build; startup then prices the stored rows.
      </p>
    </div>
  </Popover>
{/if}
