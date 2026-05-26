<script lang="ts">
  import type { Snippet } from 'svelte';

  interface TriggerArgs {
    toggle: () => void;
    open: boolean;
  }

  interface Props {
    open?: boolean;
    align?: 'left' | 'right';
    /** Tailwind width class for the panel. */
    width?: string;
    /** aria-label for the popover dialog. */
    label?: string;
    trigger: Snippet<[TriggerArgs]>;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    align = 'right',
    width = 'w-80',
    label,
    trigger,
    children,
  }: Props = $props();

  let root = $state<HTMLDivElement>();

  function toggle() {
    open = !open;
  }

  function handleWindowClick(event: MouseEvent) {
    if (root && !root.contains(event.target as Node)) open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open = false;
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<div class="relative" bind:this={root}>
  {@render trigger({ toggle, open })}
  {#if open}
    <div
      class="absolute top-full z-50 mt-2 {align === 'right' ? 'right-0' : 'left-0'} {width} rounded-lg border border-line bg-surface p-3 shadow-overlay"
      role="dialog"
      aria-label={label}
    >
      {@render children()}
    </div>
  {/if}
</div>
