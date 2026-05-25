<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    /** Lay the label out inline (left of the control) instead of stacked. */
    inline?: boolean;
    hint?: string;
    class?: string;
    children: Snippet;
  }

  let { label, inline = false, hint, class: klass = '', children }: Props = $props();
</script>

<label class="{inline ? 'flex items-center gap-2' : 'flex flex-col gap-1'} {klass}">
  <span class="text-meta text-text-muted">{label}</span>
  {@render children()}
  {#if hint && !inline}<span class="text-meta text-text-faint">{hint}</span>{/if}
</label>
