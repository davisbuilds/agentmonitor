<script lang="ts">
  // Cost×score Pareto frontier scatter for one study. Inline SVG on the shared
  // PlotFrame + scales; the geometry (points, polyline order, domination
  // connectors) comes from the pure, unit-tested frontier-geometry module.
  import type { BenchmarkArm } from '../../api/client';
  import { PlotFrame } from '../ui/chart';
  import { log10Ticks, niceLinearTicks, formatUsd } from '../ui/chart/scales';
  import { chartLayout, plotXRange, plotYRange } from '../ui/chart/layout';
  import { computeFrontier, type FrontierArmPoint } from './frontier-geometry';

  interface Props {
    arms: BenchmarkArm[];
    /** Drill-in when an arm marker is clicked. */
    onselect?: (arm: BenchmarkArm) => void;
  }

  let { arms, onselect }: Props = $props();

  const layout = chartLayout();
  const geometry = $derived(
    computeFrontier(arms, {
      xRange: plotXRange(layout.plot),
      yRange: plotYRange(layout.plot),
    }),
  );

  const xTicks = $derived(log10Ticks(geometry.costDomain[0], geometry.costDomain[1]));
  const yTicks = $derived(niceLinearTicks(0, 1, 5));
  const frontierPath = $derived(geometry.frontier.map((p) => `${p.x},${p.y}`).join(' '));

  let hovered = $state<FrontierArmPoint | null>(null);

  function money(v: number | null): string {
    if (v == null) return '—';
    return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
  }

  // Keep the tooltip inside the viewBox rather than clipping past the edges.
  const TOOLTIP_W = 136;
  function tooltipX(p: FrontierArmPoint): number {
    return Math.min(p.x + 6, layout.width - TOOLTIP_W - 2);
  }
  function tooltipY(p: FrontierArmPoint): number {
    return Math.max(p.y - 30, 2);
  }
</script>

{#if geometry.points.length === 0}
  <p class="py-6 text-center text-meta text-text-muted">
    No priced arms to plot — every arm in this study is unpriced.
  </p>
{:else}
  <PlotFrame
    {xTicks}
    {yTicks}
    xScale={geometry.xScale}
    yScale={geometry.yScale}
    formatX={formatUsd}
    formatY={(v) => v.toFixed(1)}
    xTitle="$/trial (log scale)"
    yTitle="Mean score"
    role="group"
    ariaLabel="Cost versus score frontier: {geometry.points.length} priced arms"
  >
    <!-- domination connectors (dominated arm → its dominator) -->
    {#each geometry.connectors as c}
      <line
        x1={c.from.x}
        y1={c.from.y}
        x2={c.to.x}
        y2={c.to.y}
        stroke="var(--color-line-strong)"
        stroke-width="0.75"
        stroke-dasharray="1.5 1.5"
        vector-effect="non-scaling-stroke"
        opacity="0.5"
      />
    {/each}

    <!-- Pareto frontier polyline -->
    {#if geometry.frontier.length > 1}
      <polyline
        points={frontierPath}
        fill="none"
        stroke="var(--color-accent)"
        stroke-width="1.5"
        stroke-dasharray="3 2"
        vector-effect="non-scaling-stroke"
      />
    {/if}

    <!-- arm markers: hollow ◯ native, filled ● routed -->
    {#each geometry.points as p}
      <circle
        cx={p.x}
        cy={p.y}
        r={hovered === p ? 4 : 3}
        fill={p.arm.native ? 'var(--color-surface)' : 'var(--color-accent)'}
        stroke={p.onFrontier ? 'var(--color-accent)' : 'var(--color-text-faint)'}
        stroke-width={p.onFrontier ? 1.5 : 1}
        vector-effect="non-scaling-stroke"
        class="cursor-pointer"
        role="button"
        tabindex="0"
        aria-label="{p.arm.label}: score {p.score.toFixed(2)}, {money(p.cost)} per trial"
        onmouseenter={() => (hovered = p)}
        onmouseleave={() => (hovered = null)}
        onfocus={() => (hovered = p)}
        onblur={() => (hovered = null)}
        onclick={() => onselect?.(p.arm)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onselect?.(p.arm);
          }
        }}
      />
    {/each}

    <!-- hover tooltip -->
    {#if hovered}
      {@const p = hovered}
      <g pointer-events="none">
        <rect
          x={tooltipX(p)}
          y={tooltipY(p)}
          width={TOOLTIP_W}
          height="26"
          rx="2"
          fill="var(--color-surface-2)"
          stroke="var(--color-line)"
          stroke-width="0.5"
        />
        <text x={tooltipX(p) + 4} y={tooltipY(p) + 9} class="fill-text" style="font-size: 7.5px">
          {p.arm.label}
        </text>
        <text x={tooltipX(p) + 4} y={tooltipY(p) + 20} class="fill-text-muted" style="font-size: 7px">
          score {p.score.toFixed(2)} · {money(p.cost)}/trial{p.onFrontier ? ' · frontier' : ''}
        </text>
      </g>
    {/if}
  </PlotFrame>

  <!-- legend + unpriced note -->
  <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-faint">
    <span class="inline-flex items-center gap-1">
      <svg width="16" height="6" aria-hidden="true"
        ><line x1="0" y1="3" x2="16" y2="3" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="3 2" /></svg
      >Pareto frontier
    </span>
    <span>◯ native · ● routed</span>
    {#if geometry.free.length > 0}
      <span>{geometry.free.length} free ($0) arm(s) pinned to the left edge: {geometry.free.map((a) => a.label).join(', ')}</span>
    {/if}
    {#if geometry.unpriced.length > 0}
      <span>{geometry.unpriced.length} unpriced arm(s) not shown: {geometry.unpriced.map((a) => a.label).join(', ')}</span>
    {/if}
  </div>
{/if}
