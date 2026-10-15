<script lang="ts">
  import type { Snippet } from 'svelte';
  import Popover from './Popover.svelte';
  import Button from './Button.svelte';

  interface Props {
    /** How many of the filters inside are set; shown on the button. */
    active: number;
    children: Snippet;
  }

  let { active, children }: Props = $props();
</script>

<Popover align="left" width="w-64" label="More filters">
  {#snippet trigger({ toggle, open })}
    <Button variant="neutral" size="sm" aria-label="More filters" onclick={toggle}>
      Filters
      {#if active > 0}
        <span class="tabular rounded-full bg-accent/15 px-1.5 text-accent">{active}</span>
      {/if}
      <svg
        class="h-3 w-3 text-text-faint transition-transform {open ? 'rotate-180' : ''}"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Button>
  {/snippet}

  <div class="space-y-3">{@render children()}</div>
</Popover>
