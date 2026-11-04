import assert from 'node:assert/strict';
import test from 'node:test';
import { allocate, poolProjects, quantile, sizeBucket, type Milestone } from '../src/analytics/outcomes.js';

const minute = (n: number) => Date.UTC(2026, 2, 2, 10, n);

test("each minute goes to the same root's first milestone at or after it, and minutes after the last to nothing", () => {
  type Named = Milestone & { name: string };
  // Out of order on purpose.
  const milestones: Named[] = [
    { root: 'a', at: minute(30), outcome: 'direct', name: 'push' },
    { root: 'a', at: minute(10) + 20_000, outcome: 'merged_pr', name: 'pr' },
    { root: 'b', at: minute(20), outcome: 'not_landed', name: 'other root' },
  ];
  const minutes = [
    { root: 'a', at: minute(0), observable: true },
    { root: 'a', at: minute(10), observable: true },
    { root: 'a', at: minute(15), observable: true },
    { root: 'a', at: minute(30), observable: true },
    { root: 'a', at: minute(31), observable: true },
    { root: 'b', at: minute(25), observable: true },
    { root: 'a', at: minute(5), observable: false },
    { root: null, at: minute(5), observable: false },
  ];
  assert.deepEqual(allocate(minutes, milestones).map(row => [row.outcome, row.milestone?.name ?? null]), [
    ['merged_pr', 'pr'],
    ['merged_pr', 'pr'], // a milestone later in the same minute
    ['direct', 'push'],
    ['direct', 'push'], // at the minute's start
    ['nothing_after', null],
    ['nothing_after', null], // another root's milestones are not this root's
    ['unobservable', null],
    ['unobservable', null],
  ]);
});

test('size buckets are fixed by lines changed', () => {
  assert.deepEqual([0, 199, 200, 499, 500, 999, 1000, 25_000].map(sizeBucket),
    ['<200', '<200', '200-499', '200-499', '500-999', '500-999', '1000+', '1000+']);
});

test('quantiles interpolate between ranks', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.ok(Math.abs(quantile([1, 2, 3, 4], 0.9) - 3.7) < 1e-9);
  assert.equal(quantile([7], 0.9), 7);
});

test("a project's few PRs move toward the overall figure further than a well-measured project's", () => {
  // Deterministic spread around each project's level.
  const around = (level: number, n: number) => Array.from({ length: n }, (_, i) => level * Math.exp(((i % 5) - 2) * 0.4));
  const pooled = poolProjects([
    { project: 'big', costs: around(20, 40) },
    { project: 'mid', costs: around(5, 20) },
    { project: 'small', costs: [1, 1.2] },
  ]);
  const byName = new Map(pooled.map(row => [row.project, row]));
  const big = byName.get('big')!;
  const small = byName.get('small')!;
  assert.deepEqual(pooled.map(row => [row.project, row.prs]), [['big', 40], ['mid', 20], ['small', 2]]);
  assert.equal(small.median_usd, 1.1);
  const moved = (row: { median_usd: number; pooled_usd: number }) => Math.abs(Math.log(row.pooled_usd / row.median_usd));
  assert.ok(small.pooled_usd > small.median_usd && small.pooled_usd < big.median_usd, 'pulled toward the overall figure, not past it');
  assert.ok(moved(small) > 5 * moved(big), `far more than the 40-PR one (${moved(small).toFixed(3)} vs ${moved(big).toFixed(3)})`);

  const alone = poolProjects([{ project: 'only', costs: [2, 8] }]);
  assert.ok(Math.abs(alone[0].pooled_usd - 4) < 1e-9, 'one project keeps its own figure (its geometric mean)');
});
