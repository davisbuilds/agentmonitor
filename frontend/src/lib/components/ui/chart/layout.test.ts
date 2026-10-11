import { describe, it, expect } from 'vitest';
import { chartLayout, plotXRange, plotYRange } from './layout';
import { linearScale } from './scales';

describe('chartLayout — viewBox and plot rect', () => {
  it('insets the plot rect by the default margins inside a 320×200 viewBox', () => {
    const { width, height, plot } = chartLayout();
    expect({ width, height }).toEqual({ width: 320, height: 200 });
    expect(plot).toEqual({ left: 46, right: 306, top: 12, bottom: 170, width: 260, height: 158 });
  });

  it('merges a partial margin override with the defaults', () => {
    // Only `left` changes; the other three edges keep their defaults.
    const { plot } = chartLayout({ left: 20 });
    expect(plot.left).toBe(20);
    expect(plot.right).toBe(306);
    expect(plot.top).toBe(12);
    expect(plot.bottom).toBe(170);
    expect(plot.width).toBe(286);
    expect(plot.height).toBe(158);
  });

  it('keeps width/height consistent with the edges for asymmetric margins', () => {
    const { width, height, plot } = chartLayout({ top: 5, right: 9, bottom: 41, left: 33 });
    expect(plot.right - plot.left).toBe(plot.width);
    expect(plot.bottom - plot.top).toBe(plot.height);
    // The margins are exactly what is left around the plot rect.
    expect(plot.left).toBe(33);
    expect(width - plot.right).toBe(9);
    expect(plot.top).toBe(5);
    expect(height - plot.bottom).toBe(41);
  });
});

describe('plot ranges — axis orientation', () => {
  const { plot } = chartLayout();

  it('x runs left to right', () => {
    expect(plotXRange(plot)).toEqual([46, 306]);
  });

  it('y runs bottom to top so larger values plot higher (smaller SVG y)', () => {
    expect(plotYRange(plot)).toEqual([170, 12]);
    const y = linearScale([0, 10], plotYRange(plot));
    expect(y(0)).toBe(plot.bottom);
    expect(y(10)).toBe(plot.top);
    expect(y(8)).toBeLessThan(y(2));
  });
});
