import type { ChangeMarker } from './api/client';
import type { DayMarkerGlyph } from './components/ui/chart/daily-bars';
import { agentName } from './format';

/** One marker as a day's chart shows it: a diamond for a model, a square for instructions. */
export interface DayMarker extends DayMarkerGlyph {
  kind: ChangeMarker['kind'];
}

export const CHANGE_MARKER_SHAPES: Record<ChangeMarker['kind'], DayMarkerGlyph['shape']> = { model: 'diamond', instructions: 'square' };

export function changeMarkerLabel(marker: ChangeMarker): string {
  if (marker.kind === 'model') return `${agentName(marker.agent)} took up ${marker.model}`;
  const changed = `${marker.project}: ${marker.files.join(', ')} changed`;
  return marker.commits.length === 1 ? `${changed} (${marker.commits[0].subject})` : `${changed} in ${marker.commits.length} commits`;
}

const KIND_ORDER: Record<ChangeMarker['kind'], number> = { model: 0, instructions: 1 };

/**
 * The markers to draw, by day. A project's instruction changes mark the chart
 * only when that project is selected: across every project they land on most
 * days and would mark nothing in particular.
 */
export function changeMarkerDays(markers: ChangeMarker[] | null | undefined, options: { instructions: boolean }): Map<string, DayMarker[]> {
  const days = new Map<string, Array<DayMarker & { order: number }>>();
  for (const marker of markers ?? []) {
    if (marker.kind === 'instructions' && !options.instructions) continue;
    const list = days.get(marker.date) ?? [];
    list.push({ kind: marker.kind, shape: CHANGE_MARKER_SHAPES[marker.kind], label: changeMarkerLabel(marker), order: KIND_ORDER[marker.kind] });
    days.set(marker.date, list);
  }
  return new Map([...days].map(([date, list]) => [date, list
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...marker }) => marker)]));
}
