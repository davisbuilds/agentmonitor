import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type { PullRequestLookup as Lookup, PullRequestState as State } from '../src/git/github.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-github-prs-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const {
  lookupQuery,
  parseLookupResponse,
  PULL_REQUEST_RECHECK_MS,
  pullRequestKey,
  syncPullRequestStates,
} = await import('../src/git/github.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

test('one query asks for every pull request, and an answer keeps what GitHub could resolve beside its errors', () => {
  const keys = [{ repo: 'owner/alpha', number: 7 }, { repo: 'owner/alpha', number: 999 }, { repo: 'owner/gone', number: 1 }];
  const { query, aliases } = lookupQuery(keys);
  assert.match(query, /repository\(owner: "owner", name: "alpha"\)/);
  assert.match(query, /pullRequest\(number: 7\) \{ state mergedAt createdAt \}/);
  assert.match(query, /pullRequest\(number: 999\)/);
  assert.match(query, /repository\(owner: "owner", name: "gone"\)/);
  assert.equal(aliases.size, 3);

  // As `gh api graphql` prints it, exiting 1, for a missing pull request and a missing repository.
  const [seven, missing, gone] = [...aliases.entries()].map(([alias, key]) => ({ alias, key }));
  const [repoAlias, prAlias] = seven.alias.split('.');
  const goneRepo = gone.alias.split('.')[0];
  const body = JSON.stringify({
    data: {
      [repoAlias]: { [prAlias]: { state: 'MERGED', mergedAt: '2026-03-02T20:00:00Z', createdAt: '2026-03-02T10:05:00Z' }, [missing.alias.split('.')[1]]: null },
      [goneRepo]: null,
    },
    errors: [{ type: 'NOT_FOUND', path: [repoAlias, missing.alias.split('.')[1]] }, { type: 'NOT_FOUND', path: [goneRepo] }],
  });
  assert.deepEqual(parseLookupResponse(body, aliases), new Map<string, State | null>([
    [seven.key, { state: 'MERGED', merged_at: '2026-03-02T20:00:00Z', created_at: '2026-03-02T10:05:00Z' }],
    [missing.key, null],
    [gone.key, null],
  ]));
  const forbidden = JSON.stringify({ data: { [goneRepo]: null }, errors: [{ type: 'FORBIDDEN', path: [goneRepo] }] });
  assert.equal(parseLookupResponse(forbidden, aliases).has(gone.key), false, 'a repository GitHub would not show is no answer');
  assert.equal(parseLookupResponse('gh: not logged in', aliases).size, 0);
});

test('states are recorded, and only what may still change is asked about again, once the recheck interval passes', async () => {
  const asked: string[][] = [];
  const answers = new Map<string, State | null>([
    ['owner/alpha#1', { state: 'MERGED', merged_at: '2026-03-02T20:00:00Z', created_at: '2026-03-01T09:00:00Z' }],
    ['owner/alpha#2', { state: 'OPEN', merged_at: null, created_at: '2026-03-02T09:00:00Z' }],
    ['owner/alpha#3', null],
  ]);
  const lookup: Lookup = async keys => {
    asked.push(keys.map(pullRequestKey));
    return new Map(keys.map(key => [pullRequestKey(key), answers.get(pullRequestKey(key)) ?? null]));
  };
  const keys = [1, 2, 3].map(number => ({ repo: 'owner/alpha', number }));
  const t0 = new Date('2026-03-03T00:00:00Z');

  const report = await syncPullRequestStates(db, keys, { lookup, now: t0 });
  assert.deepEqual(report, { checked: 3, merged: 1, unanswered: 0 });
  assert.deepEqual(db.prepare('SELECT number, state, merged_at, created_at FROM github_pull_requests ORDER BY number').all(), [
    { number: 1, state: 'MERGED', merged_at: '2026-03-02T20:00:00Z', created_at: '2026-03-01T09:00:00Z' },
    { number: 2, state: 'OPEN', merged_at: null, created_at: '2026-03-02T09:00:00Z' },
    { number: 3, state: null, merged_at: null, created_at: null },
  ]);

  await syncPullRequestStates(db, keys, { lookup, now: new Date(t0.getTime() + PULL_REQUEST_RECHECK_MS - 1) });
  assert.equal(asked.length, 1, 'nothing is asked again within the interval');

  answers.set('owner/alpha#2', { state: 'MERGED', merged_at: '2026-03-03T12:00:00Z', created_at: '2026-03-02T09:00:00Z' });
  await syncPullRequestStates(db, keys, { lookup, now: new Date(t0.getTime() + PULL_REQUEST_RECHECK_MS + 1) });
  assert.deepEqual(asked[1], ['owner/alpha#2', 'owner/alpha#3'], 'a merged pull request is never asked about again');
  assert.equal((db.prepare('SELECT state FROM github_pull_requests WHERE number = 2').get() as { state: string }).state, 'MERGED');
});

test('a pull request GitHub did not answer keeps what was known, and is asked about on the next pass', async () => {
  const keys = [{ repo: 'owner/beta', number: 4 }];
  const t0 = new Date('2026-03-04T00:00:00Z');
  await syncPullRequestStates(db, keys, { lookup: async () => new Map([['owner/beta#4', { state: 'OPEN', merged_at: null, created_at: '2026-03-03T09:00:00Z' }]]), now: t0 });
  const later = new Date(t0.getTime() + PULL_REQUEST_RECHECK_MS + 1);
  const report = await syncPullRequestStates(db, keys, { lookup: async () => new Map(), now: later });
  assert.deepEqual(report, { checked: 1, merged: 0, unanswered: 1 });
  const row = db.prepare('SELECT state, checked_at FROM github_pull_requests WHERE repo = ?').get('owner/beta') as { state: string; checked_at: string };
  assert.deepEqual(row, { state: 'OPEN', checked_at: t0.toISOString() });
  let asked = 0;
  await syncPullRequestStates(db, keys, { lookup: async keysAsked => { asked += keysAsked.length; return new Map(); }, now: new Date(later.getTime() + 1) });
  assert.equal(asked, 1);
});
