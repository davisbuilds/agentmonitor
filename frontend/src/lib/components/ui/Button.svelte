<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'primary' | 'neutral' | 'ghost' | 'danger';
  type Size = 'sm' | 'md';

  interface Props {
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    /** Render an anchor instead of a button. */
    href?: string;
    disabled?: boolean;
    title?: string;
    'aria-label'?: string;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  }

  let {
    variant = 'neutral',
    size = 'md',
    type = 'button',
    href,
    disabled = false,
    title,
    'aria-label': ariaLabel,
    class: klass = '',
    onclick,
    children,
  }: Props = $props();

  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const sizes: Record<Size, string> = {
    sm: 'px-2.5 py-1 text-meta',
    md: 'px-3 py-1.5 text-body',
  };
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-canvas hover:bg-accent-strong',
    neutral: 'border border-line bg-surface text-text-muted hover:border-line-strong hover:text-text',
    ghost: 'text-text-muted hover:bg-surface hover:text-text',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10',
  };

  const cls = $derived(`${base} ${sizes[size]} ${variants[variant]} ${klass}`);
</script>

{#if href}
  <a {href} class={cls} {title} aria-label={ariaLabel}>{@render children()}</a>
{:else}
  <button {type} class={cls} {disabled} {title} aria-label={ariaLabel} {onclick}>
    {@render children()}
  </button>
{/if}
