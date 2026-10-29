import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { OTHER_COLOR, SERIES_COLORS } from '../frontend/src/lib/components/usage/model-colors.js';

// The categorical checks of the dataviz palette validator, on ALL pairs. A
// stacked daily chart omits a series on days it has no volume, so any two
// series can end up touching; a palette validated on adjacent pairs only
// guarantees nothing there. Thresholds and the Machado-Oliveira-Fernandes
// (2009, severity 1.0) simulation follow the validator, whose calibration
// depends on that model.
const SURFACE = '#101419'; // the dark chart surface (--color-surface)
const BAND: [number, number] = [0.48, 0.67]; // OKLCH L, dark mode
const CHROMA_FLOOR = 0.10;
const CVD_TARGET = 8; // OKLab ΔE ×100, min(protan, deutan)
const NORMAL_FLOOR = 15; // OKLab ΔE ×100, unsimulated
const CONTRAST_MIN = 3; // WCAG, against the surface

type Rgb = [number, number, number];
const MACHADO: Record<'protan' | 'deutan', Rgb[]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex: string): Rgb => [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Rgb;
const simulate = (rgb: Rgb, kind: 'protan' | 'deutan'): Rgb =>
  MACHADO[kind].map(row => Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) as Rgb;

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

const distance = (a: Rgb, b: Rgb) => 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const normalDelta = (a: string, b: string) => distance(oklab(linear(a)), oklab(linear(b)));
const cvdDelta = (a: string, b: string) => Math.min(
  ...(['protan', 'deutan'] as const).map(kind => distance(oklab(simulate(linear(a), kind)), oklab(simulate(linear(b), kind)))),
);
const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(linear(a)), luminance(linear(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function pairs<T>(items: readonly T[]): Array<[T, T]> {
  return items.flatMap((a, i) => items.slice(i + 1).map(b => [a, b] as [T, T]));
}

describe('the shared chart series palette', () => {
  test('every color sits in the dark lightness band, above the chroma floor, and clears the surface', () => {
    for (const color of SERIES_COLORS) {
      const [L, a, b] = oklab(linear(color));
      assert.ok(L >= BAND[0] && L <= BAND[1], `${color} lightness ${L.toFixed(3)} is outside ${BAND.join('-')}`);
      assert.ok(Math.hypot(a, b) >= CHROMA_FLOOR, `${color} chroma ${Math.hypot(a, b).toFixed(3)} reads as gray`);
      assert.ok(contrast(color, SURFACE) >= CONTRAST_MIN, `${color} is under ${CONTRAST_MIN}:1 on the surface`);
    }
  });

  test('every pair stays apart for protan and deutan readers', () => {
    for (const [a, b] of pairs(SERIES_COLORS)) {
      assert.ok(cvdDelta(a, b) >= CVD_TARGET, `${a} and ${b} are ΔE ${cvdDelta(a, b).toFixed(1)} under CVD`);
    }
  });

  test('every pair stays apart with full color vision', () => {
    for (const [a, b] of pairs(SERIES_COLORS)) {
      assert.ok(normalDelta(a, b) >= NORMAL_FLOOR, `${a} and ${b} are ΔE ${normalDelta(a, b).toFixed(1)} apart`);
    }
  });

  // Other is a neutral that recedes toward the surface, so it sits below the
  // band; the legend and tooltip name it. It must still never pass for a series.
  test('Other never reads as one of the series', () => {
    for (const color of SERIES_COLORS) {
      assert.ok(cvdDelta(color, OTHER_COLOR) >= CVD_TARGET, `Other is ΔE ${cvdDelta(color, OTHER_COLOR).toFixed(1)} from ${color} under CVD`);
      assert.ok(normalDelta(color, OTHER_COLOR) >= NORMAL_FLOOR, `Other is ΔE ${normalDelta(color, OTHER_COLOR).toFixed(1)} from ${color}`);
    }
  });
});
