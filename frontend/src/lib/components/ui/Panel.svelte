<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    subtitle?: string;
    /** Pad the body. Set false for flush content like tables. */
    padded?: boolean;
    class?: string;
    /** Replaces the default title/subtitle block in the header's left slot. */
    header?: Snippet;
    /** Right-aligned header actions. */
    actions?: Snippet;
    children: Snippet;
  }

  let { title, subtitle, padded = true, class: klass = '', header, actions, children }: Props = $props();

  const showHeader = $derived(Boolean(title || subtitle || header || actions));
</script>

<section class="rounded-lg border border-line bg-surface {klass}">
  {#if showHeader}
    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      {#if header}
        {@render header()}
      {:else}
        <div class="min-w-0">
          {#if title}<h3 class="truncate text-h3">{title}</h3>{/if}
          {#if subtitle}<p class="mt-0.5 text-meta text-text-muted">{subtitle}</p>{/if}
        </div>
      {/if}
      {#if actions}
        <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
      {/if}
    </div>
  {/if}
  <div class={padded ? 'p-4' : ''}>
    {@render children()}
  </div>
</section>
