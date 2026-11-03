import { describe, expect, it } from 'vitest';
import type { ChangeMarker } from './api/client';
import { changeMarkerDays, changeMarkerLabel } from './change-markers';

const model: ChangeMarker = { kind: 'model', date: '2026-03-04', at: '2026-03-04T12:00:00Z', agent: 'claude', model: 'claude-opus-5' };
const instructions: ChangeMarker = {
  kind: 'instructions', date: '2026-03-04', at: '2026-03-04T10:00:00Z', project: 'alpha',
  files: ['AGENTS.md', 'frontend/CLAUDE.md'], commits: [{ sha: 'a1', subject: 'docs: agent rules' }, { sha: 'a2', subject: 'docs: agent rules (#4)' }],
};
const single: ChangeMarker = { ...instructions, date: '2026-03-07', files: ['CLAUDE.md'], commits: [{ sha: 'b1', subject: 'docs: tighten the review rule' }] };

describe('changeMarkerLabel', () => {
  it('names the agent and model, or the project, files and change', () => {
    expect(changeMarkerLabel(model)).toBe('Claude Code took up claude-opus-5');
    expect(changeMarkerLabel(instructions)).toBe('alpha: AGENTS.md, frontend/CLAUDE.md changed in 2 commits');
    expect(changeMarkerLabel(single)).toBe('alpha: CLAUDE.md changed (docs: tighten the review rule)');
  });
});

describe('changeMarkerDays', () => {
  it('groups markers by day, models first', () => {
    const days = changeMarkerDays([instructions, model, single], { instructions: true });
    expect([...days.keys()]).toEqual(['2026-03-04', '2026-03-07']);
    expect(days.get('2026-03-04')!.map(marker => marker.kind)).toEqual(['model', 'instructions']);
  });

  it('leaves instruction changes off unless a project is selected', () => {
    const days = changeMarkerDays([instructions, model, single], { instructions: false });
    expect([...days.entries()].map(([date, list]) => [date, list.map(marker => marker.kind)])).toEqual([['2026-03-04', ['model']]]);
  });

  it('draws nothing without markers', () => {
    expect(changeMarkerDays(null, { instructions: true }).size).toBe(0);
  });
});
