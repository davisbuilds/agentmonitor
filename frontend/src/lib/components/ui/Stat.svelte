<script lang="ts">
  type DeltaTone = 'ok' | 'danger' | 'muted';

  interface Props {
    label: string;
    value: string | number;
    /** Secondary line under the value. */
    sub?: string;
    /** Trend indicator, e.g. { value: '+3.1%', tone: 'ok' }. */
    delta?: { value: string; tone?: DeltaTone };
    /** `lg` promotes the value to display size for bento emphasis. */
    size?: 'md' | 'lg';
    class?: string;
  }

  let { label, value, sub, delta, size = 'md', class: klass = '' }: Props = $props();

  const deltaTone: Record<DeltaTone, string> = {
    ok: 'text-ok',
    danger: 'text-danger',
    muted: 'text-text-faint',
  };
</script>

<div class={klass}>
  <div class="text-meta text-text-muted">{label}</div>
  <div class="flex items-baseline gap-2">
    <span class="tabular font-mono text-text {size === 'lg' ? 'text-display' : 'text-h2'}">{value}</span>
    {#if delta}
      <span class="text-meta {deltaTone[delta.tone ?? 'muted']}">{delta.value}</span>
    {/if}
  </div>
  {#if sub}<div class="mt-0.5 text-meta text-text-faint">{sub}</div>{/if}
</div>
