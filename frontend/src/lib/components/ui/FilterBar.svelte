<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Left cluster: the page's scope (sub-tabs or search), then its filters. */
    children: Snippet;
    /** Right cluster: counts and actions (Clear / Refresh / Export). */
    end?: Snippet;
  }

  let { children, end }: Props = $props();
</script>

<!--
  The one filter row under the command bar, laid out the same on every tab:
  scope first, then Project and Agent, then the page's own filters, with
  less-used ones behind a MoreFilters button so the row never wraps on desktop.
-->
<div
  data-testid="filter-bar"
  role="group"
  aria-label="Filters"
  class="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 sm:px-6"
>
  <div class="flex min-w-0 flex-wrap items-center gap-2">{@render children()}</div>
  {#if end}
    <div class="ml-auto flex shrink-0 items-center gap-2">{@render end()}</div>
  {/if}
</div>
