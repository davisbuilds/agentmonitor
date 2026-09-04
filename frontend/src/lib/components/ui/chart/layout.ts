// Shared viewBox + plot-rect geometry for inline-SVG charts drawn on PlotFrame.
//
// A real-aspect viewBox (not preserveAspectRatio="none") so circles stay round
// and tick text stays legible. Consumers build their scales into the returned
// plot rect and hand the same scales to PlotFrame, which draws the frame; the
// marks stay per-view.

export interface PlotRect {
  /** left edge x (viewBox units). */
  left: number;
  /** right edge x. */
  right: number;
  /** bottom edge y (the larger y, since SVG y grows downward). */
  bottom: number;
  /** top edge y (the smaller y). */
  top: number;
  width: number;
  height: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  plot: PlotRect;
}

export interface ChartMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_VIEWBOX = { width: 320, height: 200 } as const;
const DEFAULT_MARGIN: ChartMargins = { top: 12, right: 14, bottom: 30, left: 46 };

/** Build the viewBox + inner plot rect for a chart. */
export function chartLayout(margin: Partial<ChartMargins> = {}): ChartLayout {
  const m = { ...DEFAULT_MARGIN, ...margin };
  const { width, height } = DEFAULT_VIEWBOX;
  const plot: PlotRect = {
    left: m.left,
    right: width - m.right,
    bottom: height - m.bottom,
    top: m.top,
    width: width - m.left - m.right,
    height: height - m.top - m.bottom,
  };
  return { width, height, plot };
}

/** x range [left, right] for a scale mapping into a plot rect. */
export function plotXRange(plot: PlotRect): [number, number] {
  return [plot.left, plot.right];
}

/**
 * y range [bottom, top] — pass this to a linear scale so the smaller domain
 * value lands at the bottom and larger at the top (SVG y is inverted).
 */
export function plotYRange(plot: PlotRect): [number, number] {
  return [plot.bottom, plot.top];
}
