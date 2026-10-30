// Polyline geometry for Sparkline: a value per day from zero to the series'
// peak. A day without a value (a rate with nothing to divide) breaks the line
// rather than dropping it to zero.

export const SPARKLINE_WIDTH = 100;
export const SPARKLINE_HEIGHT = 28;

export function sparklineSegments(values: Array<number | null>): string[] {
  const peak = Math.max(0, ...values.filter((value): value is number => value !== null));
  const step = values.length > 1 ? SPARKLINE_WIDTH / (values.length - 1) : 0;
  // Inset by the stroke so the peak and the baseline stay inside the box.
  const y = (value: number) => (peak > 0 ? SPARKLINE_HEIGHT - 1 - (value / peak) * (SPARKLINE_HEIGHT - 2) : SPARKLINE_HEIGHT - 1);
  const segments: string[] = [];
  let points: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (points.length > 0) segments.push(points.join(' '));
      points = [];
      return;
    }
    points.push(`${(index * step).toFixed(2)},${y(value).toFixed(2)}`);
  });
  if (points.length > 0) segments.push(points.join(' '));
  return segments;
}
