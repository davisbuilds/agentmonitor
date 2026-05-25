<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

  interface Props {
    tone?: Tone;
    class?: string;
    children: Snippet;
  }

  let { tone = 'neutral', class: klass = '', children }: Props = $props();

  // Subtle tints — not loud, uppercase, full-saturation pills.
  const tones: Record<Tone, string> = {
    neutral: 'bg-surface-2 text-text-muted',
    accent: 'bg-accent/15 text-accent',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
  };
</script>

<span class="inline-flex items-center rounded-sm px-1.5 py-0.5 text-meta {tones[tone]} {klass}">
  {@render children()}
</span>
