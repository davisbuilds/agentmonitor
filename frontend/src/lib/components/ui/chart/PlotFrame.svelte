<script lang="ts">
  // Thin, tokenized chart frame: gridlines, tick labels, and axis titles for a
  // plot rect, given ready-made scales + tick values. No marks and no data
  // opinions — the consumer renders its own <circle>/<polyline> marks into the
  // `children` snippet using the same scales. See docs/system/DESIGN.md.
  import type { Snippet } from 'svelte';
  import type { Scale } from './scales';
  import { chartLayout, type ChartMargins } from './layout';

  interface Props {
    xScale: Scale;
    yScale: Scale;
    xTicks: number[];
    yTicks: number[];
    formatX?: (v: number) => string;
    formatY?: (v: number) => string;
    xTitle?: string;
    yTitle?: string;
    margin?: Partial<ChartMargins>;
    /** Accessible description of the plotted marks. */
    ariaLabel?: string;
    class?: string;
    children?: Snippet;
  }

  let {
    xScale,
    yScale,
    xTicks,
    yTicks,
    formatX = (v) => String(v),
    formatY = (v) => String(v),
    xTitle,
    yTitle,
    margin,
    ariaLabel,
    class: klass = '',
    children,
  }: Props = $props();

  const layout = $derived(chartLayout(margin));
  const plot = $derived(layout.plot);
</script>

<svg
  viewBox="0 0 {layout.width} {layout.height}"
  class="w-full {klass}"
  style="aspect-ratio: {layout.width} / {layout.height}"
  role="img"
  aria-label={ariaLabel}
>
  <!-- horizontal gridlines + y tick labels -->
  {#each yTicks as t}
    {@const y = yScale(t)}
    <line
      x1={plot.left}
      x2={plot.right}
      y1={y}
      y2={y}
      stroke="var(--color-line)"
      stroke-width="0.5"
      vector-effect="non-scaling-stroke"
    />
    <text
      x={plot.left - 5}
      y={y}
      text-anchor="end"
      dominant-baseline="middle"
      class="fill-text-faint"
      style="font-size: 8px"
    >{formatY(t)}</text>
  {/each}

  <!-- x tick marks + labels -->
  {#each xTicks as t}
    {@const x = xScale(t)}
    <line
      x1={x}
      x2={x}
      y1={plot.bottom}
      y2={plot.bottom + 3}
      stroke="var(--color-line)"
      stroke-width="0.5"
      vector-effect="non-scaling-stroke"
    />
    <text
      x={x}
      y={plot.bottom + 12}
      text-anchor="middle"
      class="fill-text-faint"
      style="font-size: 8px"
    >{formatX(t)}</text>
  {/each}

  <!-- axis frame (left + bottom) -->
  <line
    x1={plot.left}
    x2={plot.left}
    y1={plot.top}
    y2={plot.bottom}
    stroke="var(--color-line-strong)"
    stroke-width="0.75"
    vector-effect="non-scaling-stroke"
  />
  <line
    x1={plot.left}
    x2={plot.right}
    y1={plot.bottom}
    y2={plot.bottom}
    stroke="var(--color-line-strong)"
    stroke-width="0.75"
    vector-effect="non-scaling-stroke"
  />

  {#if xTitle}
    <text
      x={(plot.left + plot.right) / 2}
      y={layout.height - 2}
      text-anchor="middle"
      class="fill-text-muted"
      style="font-size: 8.5px"
    >{xTitle}</text>
  {/if}
  {#if yTitle}
    <text
      x={10}
      y={(plot.top + plot.bottom) / 2}
      text-anchor="middle"
      transform="rotate(-90 10 {(plot.top + plot.bottom) / 2})"
      class="fill-text-muted"
      style="font-size: 8.5px"
    >{yTitle}</text>
  {/if}

  <!-- consumer marks -->
  {@render children?.()}
</svg>
