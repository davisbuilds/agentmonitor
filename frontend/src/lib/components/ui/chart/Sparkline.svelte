<script lang="ts">
  // WHY: Hide the decorative trend from assistive technology because the tile already exposes its
  // values as text.
  import { SPARKLINE_HEIGHT, SPARKLINE_WIDTH, sparklineSegments } from './sparkline';

  interface Props {
    values: Array<number | null>;
    color?: string;
    class?: string;
  }

  let { values, color = 'var(--color-accent)', class: klass = 'h-7' }: Props = $props();

  const segments = $derived(sparklineSegments(values));
</script>

<svg
  viewBox="0 0 {SPARKLINE_WIDTH} {SPARKLINE_HEIGHT}"
  preserveAspectRatio="none"
  class="w-full {klass}"
  aria-hidden="true"
>
  {#each segments as points}
    <polyline
      {points}
      fill="none"
      stroke={color}
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  {/each}
</svg>
