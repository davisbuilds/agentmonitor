<script lang="ts">
  import type { Snippet } from 'svelte';
  import Popover from './Popover.svelte';

  // The single ⓘ a heading carries in place of a subtitle or banner
  // (DESIGN.md: collapse heading + subtitle + banner into one affordance).
  interface Props {
    /** What the note explains; the button's accessible name is "About <label>". */
    label: string;
    align?: 'left' | 'right';
    width?: string;
    children: Snippet;
  }

  let { label, align = 'left', width = 'w-80', children }: Props = $props();
</script>

<Popover {align} {width} label={`About ${label}`}>
  {#snippet trigger({ toggle, open })}
    <button
      type="button"
      class="inline-flex h-5 w-5 items-center justify-center rounded-full text-meta text-text-faint transition-colors hover:bg-surface-2 hover:text-text"
      aria-label={`About ${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={toggle}
    >ⓘ</button>
  {/snippet}
  <div class="space-y-2 text-meta text-text-muted">
    {@render children()}
  </div>
</Popover>
