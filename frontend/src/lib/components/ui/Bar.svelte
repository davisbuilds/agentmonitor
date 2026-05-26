<script lang="ts">
  type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'auto';

  interface Props {
    value: number;
    max?: number;
    /** `auto` colors by threshold (>=85 danger, >=60 warn, else ok). */
    tone?: Tone;
    class?: string;
  }

  let { value, max = 100, tone = 'accent', class: klass = '' }: Props = $props();

  const percent = $derived(max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100)));

  const fill = $derived.by(() => {
    if (tone !== 'auto') {
      return { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }[tone];
    }
    if (percent >= 85) return 'bg-danger';
    if (percent >= 60) return 'bg-warn';
    return 'bg-ok';
  });
</script>

<div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-2 {klass}">
  <div class="h-full rounded-full {fill}" style="width:{percent}%"></div>
</div>
