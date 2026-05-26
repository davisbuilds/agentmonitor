<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Left cluster — typically filters/controls. */
    children: Snippet;
    /** Right cluster — typically buttons (Reset / Refresh / Export). */
    actions?: Snippet;
    class?: string;
  }

  let { children, actions, class: klass = '' }: Props = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-3 {klass}">
  <div class="flex flex-wrap items-center gap-2">{@render children()}</div>
  {#if actions}
    <div class="flex items-center gap-2">{@render actions()}</div>
  {/if}
</div>
