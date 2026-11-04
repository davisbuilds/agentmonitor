<script lang="ts">
  // One weekly measure of cost per outcome on its own axis: a line through the
  // weeks with merges (a week without any leaves a gap), and for the median its
  // middle-half band. Hovering a week reads its value out above the plot.
  import { PlotFrame, chartLayout, linearScale, niceLinearTicks, plotXRange, plotYRange } from '../ui/chart';
  import { formatDateOnly } from '../../format';
  import type { WeekPoint } from '../../outcome-chart';

  interface Props {
    title: string;
    points: WeekPoint[];
    /** Every week the range holds (its Monday), including those without merges. */
    weeks: string[];
    color: string;
    format: (value: number) => string;
  }

  let { title, points, weeks, color, format }: Props = $props();

  const layout = chartLayout({ left: 40, bottom: 22 });
  const plot = layout.plot;
  const top = $derived(Math.max(0, ...points.map(p => Math.max(p.value, p.high ?? 0))));
  const yTicks = $derived(niceLinearTicks(0, top || 1, 4));
  const yScale = $derived(linearScale([0, yTicks[yTicks.length - 1]], plotYRange(plot)));
  const xScale = $derived(linearScale([0, Math.max(weeks.length - 1, 1)], plotXRange(plot)));
  // A few week labels: the ends and the middle.
  const xTicks = $derived([...new Set([0, Math.floor((weeks.length - 1) / 2), weeks.length - 1])].filter(i => i >= 0));
  // Contiguous runs of weeks, so a gap is not bridged by the line.
  const runs = $derived.by(() => {
    const out: WeekPoint[][] = [];
    for (const point of points) {
      const last = out[out.length - 1];
      if (last && last[last.length - 1].index === point.index - 1) last.push(point);
      else out.push([point]);
    }
    return out;
  });
  const path = (run: WeekPoint[], value: (p: WeekPoint) => number) => run.map(p => `${xScale(p.index)},${yScale(value(p))}`).join(' ');

  let hovered = $state<WeekPoint | null>(null);
  function hover(event: PointerEvent): void {
    const svg = (event.currentTarget as SVGElement).ownerSVGElement ?? (event.currentTarget as SVGSVGElement);
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * layout.width;
    let best: WeekPoint | null = null;
    for (const point of points) {
      if (!best || Math.abs(xScale(point.index) - x) < Math.abs(xScale(best.index) - x)) best = point;
    }
    hovered = best;
  }
  const weekLabel = (week: string) => `Week of ${formatDateOnly(week)}`;
  const shortDay = (week: string) => new Date(`${week}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
</script>

<figure class="min-w-0">
  <figcaption class="text-meta text-text-muted">
    <div>{title}</div>
    <!-- A line of its own, held open, so hovering does not move the plot. -->
    <div class="tabular min-h-[1.25rem] truncate font-mono text-text" aria-live="polite">
      {#if hovered}{weekLabel(hovered.week)}: {format(hovered.value)}{#if hovered.low !== null && hovered.high !== null} ({format(hovered.low)}–{format(hovered.high)}){/if}, {hovered.prs} PR{hovered.prs === 1 ? '' : 's'}{/if}
    </div>
  </figcaption>
  <PlotFrame
    {xScale}
    {yScale}
    {xTicks}
    {yTicks}
    margin={{ left: 40, bottom: 22 }}
    formatX={i => (weeks[i] ? shortDay(weeks[i]) : '')}
    formatY={format}
    ariaLabel={`${title}, by week of merge`}
  >
    {#each runs as run, r (r)}
      {#if run[0].low !== null}
        <polygon
          points={`${path(run, p => p.high ?? p.value)} ${path([...run].reverse(), p => p.low ?? p.value)}`}
          fill={color}
          fill-opacity="0.18"
        />
      {/if}
      <polyline points={path(run, p => p.value)} fill="none" stroke={color} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    {/each}
    {#each points as point (point.index)}
      <circle cx={xScale(point.index)} cy={yScale(point.value)} r={hovered?.index === point.index ? 4 : 2.5} fill={color} stroke="var(--color-surface)" stroke-width="1.5" />
    {/each}
    {#if hovered}
      <line x1={xScale(hovered.index)} x2={xScale(hovered.index)} y1={plot.top} y2={plot.bottom} stroke="var(--color-line-strong)" stroke-width="0.75" vector-effect="non-scaling-stroke" />
    {/if}
    <rect
      x={plot.left}
      y={plot.top}
      width={plot.width}
      height={plot.height}
      fill="transparent"
      role="presentation"
      onpointermove={hover}
      onpointerleave={() => (hovered = null)}
    />
  </PlotFrame>
</figure>
