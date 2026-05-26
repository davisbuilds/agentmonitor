<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    class?: string;
    /** Optional call-to-action (e.g. a Button). */
    action?: Snippet;
  }

  let { title, description, class: klass = '', action }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center {klass}">
  <p class="text-body text-text-muted">{title}</p>
  {#if description}<p class="max-w-[48ch] text-meta text-text-faint">{description}</p>{/if}
  {#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
