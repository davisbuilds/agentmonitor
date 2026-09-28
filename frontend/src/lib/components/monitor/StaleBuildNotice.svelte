<script lang="ts">
  import { getServerBuildStale } from '../../stores/monitor.svelte';
  import { Popover } from '../ui';

  const stale = $derived(getServerBuildStale());
</script>

{#if stale}
  <Popover align="right" width="w-72" label="Server restart needed">
    {#snippet trigger({ toggle, open })}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-sm border border-warn/40 px-2 py-1 text-meta text-warn transition-colors hover:border-warn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onclick={toggle}
        data-testid="stale-build-notice"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-warn"></span>
        Restart needed
      </button>
    {/snippet}
    <div class="space-y-2 text-meta">
      <p class="text-text">This server is running an older build than the one on disk.</p>
      <p class="text-text-muted">
        It keeps the code it started with, so imports and fixes in the new build do not
        apply until it restarts. Restart <code class="font-mono">amon serve</code> to load it.
      </p>
    </div>
  </Popover>
{/if}
