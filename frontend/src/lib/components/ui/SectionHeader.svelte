<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Optional count/meta shown next to the title (e.g. "12 sessions"). */
    count?: string | number;
    actions?: Snippet;
    class?: string;
  }

  let { title, count, actions, class: klass = '' }: Props = $props();
</script>

<div class="mb-3 flex items-center justify-between gap-3 {klass}">
  <div class="flex items-baseline gap-2">
    <h2 class="text-h2">{title}</h2>
    {#if count != null}<span class="tabular text-meta text-text-muted">{count}</span>{/if}
  </div>
  {#if actions}
    <div class="flex items-center gap-2">{@render actions()}</div>
  {/if}
</div>
