import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type {
  AuthoredPullRequest, PullRequestLookup as Lookup, PullRequestSearch, PullRequestState as State,
} from '../src/git/github.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-github-prs-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const {
  lookupQuery,
  parseLookupResponse,
  parseSearchResponse,
  PULL_REQUEST_RECHECK_MS,
  pullRequestKey,
  searchQuery,
  syncAuthoredPullRequests,
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
  assert.match(query, /pullRequest\(number: 7\) \{ state mergedAt createdAt additions deletions changedFiles author \{ __typename \} commits\(first: 100\) \{ totalCount nodes \{ commit \{ oid \} \} \} \}/);
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
  const detailed = (nodes: unknown[]) => ({
    state: 'MERGED', mergedAt: '2026-03-02T20:00:00Z', createdAt: '2026-03-02T10:05:00Z',
    additions: 5, deletions: 1, changedFiles: 1, author: { __typename: 'User' }, commits: { totalCount: nodes.length, nodes },
  });
  const merged = { state: 'MERGED', merged_at: '2026-03-02T20:00:00Z', created_at: '2026-03-02T10:05:00Z' } as const;
  const whole = JSON.stringify({ data: { [repoAlias]: { [prAlias]: detailed([{ commit: { oid: 'c1' } }]) } } });
  assert.deepEqual(parseLookupResponse(whole, aliases).get(seven.key), {
    ...merged, details: { additions: 5, deletions: 1, changed_files: 1, commit_count: 1, author_is_bot: false, commits: ['c1'] },
  });
  const erred = JSON.stringify({
    data: { [repoAlias]: { [prAlias]: { ...detailed([{ commit: { oid: 'c1' } }]), author: null } } },
    errors: [{ type: 'SERVICE_UNAVAILABLE', path: [repoAlias, prAlias, 'author'] }],
  });
  assert.deepEqual(parseLookupResponse(erred, aliases).get(seven.key), { ...merged, partial: true }, 'details GitHub answered in part are not taken');
  const unresolved = JSON.stringify({ data: { [repoAlias]: { [prAlias]: detailed([{ commit: { oid: 'c1' } }, { commit: null }]) } } });
  assert.deepEqual(parseLookupResponse(unresolved, aliases).get(seven.key), { ...merged, partial: true }, 'nor a commit that did not resolve');
  const elsewhere = JSON.stringify({
    data: { [repoAlias]: { [prAlias]: detailed([{ commit: { oid: 'c1' } }]) } },
    errors: [{ type: 'NOT_FOUND', path: [goneRepo] }],
  });
  assert.equal(parseLookupResponse(elsewhere, aliases).get(seven.key)?.partial, undefined, 'an error under another pull request leaves this one whole');
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

const members = (repo: string, number: number) => (db.prepare(
  'SELECT sha, source FROM github_pull_request_commits WHERE repo = ? AND number = ? ORDER BY sha',
).all(repo, number) as Array<{ sha: string; source: string }>).map(row => `${row.sha} ${row.source}`);

test('an answer with details records size, author and commits, and a merged pull request without them is asked once more', async () => {
  db.prepare("INSERT INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at) VALUES ('owner/gamma', 9, 'MERGED', '2026-03-05T00:00:00Z', '2026-03-04T00:00:00Z', '2026-03-05T01:00:00Z')").run();
  db.prepare("INSERT INTO github_pull_request_commits (repo, number, sha, source) VALUES ('owner/gamma', 9, 'from-a-merge', 'local')").run();
  const asked: string[] = [];
  const lookup: Lookup = async keys => {
    asked.push(...keys.map(pullRequestKey));
    return new Map(keys.map(key => [pullRequestKey(key), {
      state: 'MERGED', merged_at: '2026-03-05T00:00:00Z', created_at: '2026-03-04T00:00:00Z',
      details: { additions: 40, deletions: 4, changed_files: 3, commit_count: 2, author_is_bot: true, commits: ['c1', 'c2'] },
    } satisfies State]));
  };
  const keys = [{ repo: 'owner/gamma', number: 9 }];
  await syncPullRequestStates(db, keys, { lookup, now: new Date('2026-03-06T00:00:00Z') });
  assert.deepEqual(asked, ['owner/gamma#9'], 'stored before details were read, so asked once more');
  assert.deepEqual(db.prepare("SELECT additions, deletions, changed_files, commit_count, author_is_bot FROM github_pull_requests WHERE repo = 'owner/gamma'").get(),
    { additions: 40, deletions: 4, changed_files: 3, commit_count: 2, author_is_bot: 1 });
  assert.deepEqual(members('owner/gamma', 9), ['c1 github', 'c2 github'], "GitHub's list replaces a local merge's");
  await syncPullRequestStates(db, keys, { lookup, now: new Date('2026-03-08T00:00:00Z') });
  assert.equal(asked.length, 1, 'and never again');
});

test('a merged pull request whose details answered in part keeps what was known, and is asked about again', async () => {
  db.prepare("INSERT INTO github_pull_requests (repo, number, state, checked_at, additions, details_at) VALUES ('owner/epsilon', 2, 'OPEN', '2026-03-01T00:00:00Z', 7, '2026-03-01T00:00:00Z')").run();
  db.prepare("INSERT INTO github_pull_request_commits (repo, number, sha, source) VALUES ('owner/epsilon', 2, 'from-a-merge', 'local')").run();
  const keys = [{ repo: 'owner/epsilon', number: 2 }];
  const merged = { state: 'MERGED', merged_at: '2026-03-06T00:00:00Z', created_at: '2026-03-01T00:00:00Z' } as const;
  let answer: State = { ...merged, partial: true };
  const asked: string[] = [];
  const lookup: Lookup = async keysAsked => {
    asked.push(...keysAsked.map(pullRequestKey));
    return new Map(keysAsked.map(key => [pullRequestKey(key), answer]));
  };
  const row = () => db.prepare("SELECT state, merged_at, additions, details_at FROM github_pull_requests WHERE repo = 'owner/epsilon'").get();

  await syncPullRequestStates(db, keys, { lookup, now: new Date('2026-03-07T00:00:00Z') });
  assert.deepEqual(row(), { state: 'MERGED', merged_at: '2026-03-06T00:00:00Z', additions: 7, details_at: null }, 'the state is recorded, and the details left due');
  assert.deepEqual(members('owner/epsilon', 2), ['from-a-merge local'], 'a partial list replaces nothing');

  answer = { ...merged, details: { additions: 9, deletions: 0, changed_files: 1, commit_count: 1, author_is_bot: false, commits: ['e1'] } };
  await syncPullRequestStates(db, keys, { lookup, now: new Date('2026-03-07T00:05:00Z') });
  assert.equal(asked.length, 2, 'asked again on the next pass, without waiting for the recheck interval');
  assert.deepEqual(row(), { state: 'MERGED', merged_at: '2026-03-06T00:00:00Z', additions: 9, details_at: '2026-03-07T00:05:00.000Z' });
  assert.deepEqual(members('owner/epsilon', 2), ['e1 github']);
  await syncPullRequestStates(db, keys, { lookup, now: new Date('2026-03-08T00:00:00Z') });
  assert.equal(asked.length, 2, 'and, whole, never again');
});

test("the search asks for the user's pull requests merged in a window, a page at a time, with their size and commits", () => {
  const query = searchQuery({ from: '2026-10-01', to: '2026-10-31' }, 'Y3Vyc29y');
  assert.match(query, /search\(type: ISSUE, first: 25, after: "Y3Vyc29y", query: "is:pr is:merged author:@me merged:2026-10-01\.\.2026-10-31"\)/);
  assert.match(query, /\.\.\. on PullRequest \{ number repository \{ nameWithOwner \} createdAt mergedAt additions deletions changedFiles author \{ __typename \} commits\(first: 100\)/);
  assert.doesNotMatch(searchQuery({ from: '2026-10-01', to: '2026-10-31' }, null), /after:/);
  assert.throws(() => searchQuery({ from: '2026-10-01" author:x', to: '2026-10-31' }, null), /window/);
  assert.match(searchQuery({ from: '2026-10-01', to: '2026-10-31' }, 'a"b'), /after: "a\\"b"/, 'a cursor is quoted, never spliced in');

  const node = {
    number: 6, repository: { nameWithOwner: 'Owner/Alpha' }, createdAt: '2026-10-02T10:00:00Z', mergedAt: '2026-10-03T10:00:00Z',
    additions: 10, deletions: 2, changedFiles: 3, author: { __typename: 'User' },
    commits: { totalCount: 1, nodes: [{ commit: { oid: 'a1' } }] },
  };
  const page = parseSearchResponse(JSON.stringify({ data: { search: { issueCount: 2, pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [node, {}] } } }));
  assert.deepEqual(page, {
    total: 2, next: 'next', complete: false,
    pulls: [{
      repo: 'owner/alpha', number: 6, created_at: '2026-10-02T10:00:00Z', merged_at: '2026-10-03T10:00:00Z',
      additions: 10, deletions: 2, changed_files: 3, commit_count: 1, author_is_bot: false, commits: ['a1'],
    }],
  });
  assert.equal(page?.pulls.length, 1, 'a result that did not answer leaves the page incomplete, keeping the rest');
  const whole = parseSearchResponse(JSON.stringify({ data: { search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } }));
  assert.equal(whole?.complete, true);
  assert.equal(whole?.next, null);
  const partial = parseSearchResponse(JSON.stringify({
    data: { search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node, null] } },
    errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['search', 'nodes', '1'] }],
  }));
  assert.deepEqual([partial?.pulls.length, partial?.complete], [1, false], 'GitHub answering part of a page, with an error');
  const flagged = parseSearchResponse(JSON.stringify({
    data: { search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } },
    errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['search', 'nodes', '0', 'commits'] }],
  }));
  assert.equal(flagged?.complete, false, 'an error beside an answer leaves it incomplete too');
  const commitless = parseSearchResponse(JSON.stringify({
    data: { search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...node, commits: { totalCount: 2, nodes: [{ commit: { oid: 'a1' } }, { commit: null }] } }] } },
  }));
  assert.deepEqual([commitless?.pulls.length, commitless?.complete], [0, false], 'as does a commit that did not resolve');
  assert.equal(parseSearchResponse('gh: not logged in'), null);
  assert.equal(parseSearchResponse(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] })), null);
});

test('merged pull requests are read window by window: a full window splits, pages are followed, and only a whole window counts as read', async () => {
  const pull = (number: number, mergedAt: string): AuthoredPullRequest => ({
    repo: 'owner/delta', number, created_at: mergedAt, merged_at: mergedAt,
    additions: number, deletions: 0, changed_files: 1, commit_count: 1, author_is_bot: false, commits: [`sha-${number}`],
  });
  // What GitHub holds, by merge day.
  const held = [pull(1, '2026-03-02T10:00:00Z'), pull(2, '2026-03-10T10:00:00Z'), pull(3, '2026-03-20T10:00:00Z'), pull(4, '2026-03-28T10:00:00Z'),
    pull(5, '2026-06-05T10:00:00Z'), pull(6, '2026-06-06T10:00:00Z'), pull(8, '2026-07-07T10:00:00Z'), pull(9, '2026-08-08T10:00:00Z'), pull(7, '2026-10-20T10:00:00Z')];
  db.prepare("INSERT INTO github_pull_request_commits (repo, number, sha, source) VALUES ('owner/delta', 7, 'from-a-merge', 'local')").run();
  let failJuneSecondPage = true;
  let partialPages = true;
  const asked: string[] = [];
  const search: PullRequestSearch = async (window, after) => {
    asked.push(`${window.from}..${window.to}${after ? ` after ${after}` : ''}`);
    const inWindow = held.filter(p => p.merged_at.slice(0, 10) >= window.from && p.merged_at.slice(0, 10) <= window.to);
    const offset = after ? Number(after) : 0;
    if (window.from.startsWith('2026-06') && offset > 0 && failJuneSecondPage) return null;
    // As GitHub does, a search returns no result past the cap.
    if (offset >= 3) return { total: inWindow.length, pulls: [], next: null, complete: true };
    // On the first pass July's second page answers only in part: its one result does not.
    if (window.from.startsWith('2026-07') && partialPages) {
      return offset === 0
        ? { total: inWindow.length + 1, pulls: inWindow, next: '1', complete: true }
        : { total: inWindow.length + 1, pulls: [], next: null, complete: false };
    }
    // And August's only page.
    if (window.from.startsWith('2026-08') && partialPages) return { total: inWindow.length + 1, pulls: inWindow, next: null, complete: false };
    // One per page, to exercise paging.
    return { total: inWindow.length, pulls: inWindow.slice(offset, offset + 1), next: offset + 1 < inWindow.length ? String(offset + 1) : null, complete: true };
  };
  const now = new Date('2026-11-15T00:00:00Z');
  const report = await syncAuthoredPullRequests(db, { search, now, cap: 3 });

  assert.ok(asked.includes('2026-03-01..2026-03-31'), 'March is asked whole first');
  assert.ok(asked.includes('2026-03-01..2026-03-16') && asked.includes('2026-03-17..2026-03-31'), 'and, holding more than the cap, in halves');
  assert.ok(asked.some(a => a.startsWith('2026-03-17..2026-03-31 after')), 'each half paged through');
  assert.ok(asked[0].startsWith('2025-11-01'), 'reaching back a year, from the start of that month');
  assert.deepEqual(report, { windows: 10, pull_requests: 8, unanswered: 3 });
  const stored = db.prepare("SELECT number, state, merged_at, additions, details_at FROM github_pull_requests WHERE repo = 'owner/delta' ORDER BY number").all() as Array<{ number: number; state: string; details_at: string }>;
  assert.deepEqual(stored.map(row => row.number), [1, 2, 3, 4, 5, 7, 8, 9], "June's second page went unanswered; July's and August's answered parts are kept");
  assert.ok(stored.every(row => row.state === 'MERGED' && row.details_at === now.toISOString()));
  assert.deepEqual(members('owner/delta', 7), ['sha-7 github']);
  const windows = (db.prepare('SELECT window_start FROM github_pull_request_search ORDER BY window_start').all() as Array<{ window_start: string }>).map(row => row.window_start);
  assert.ok(!windows.includes('2026-06-01'), 'June is not read until every page is');
  assert.ok(!windows.includes('2026-07-01') && !windows.includes('2026-08-01'), 'nor July or August until every result on their pages is');
  assert.ok(windows.includes('2026-03-01'), 'a split month is read once both halves are');
  assert.equal(windows.length, 10);

  asked.length = 0;
  failJuneSecondPage = false;
  partialPages = false;
  await syncAuthoredPullRequests(db, { search, now: new Date(now.getTime() + 10 * 60_000), cap: 3 });
  assert.deepEqual(asked.map(a => a.split(' ')[0]).filter((a, i, all) => all.indexOf(a) === i), ['2026-06-01..2026-06-30', '2026-07-01..2026-07-31', '2026-08-01..2026-08-31'],
    'a read window is not asked again, and recent months wait for the recheck interval');
  assert.ok(db.prepare("SELECT 1 FROM github_pull_requests WHERE repo = 'owner/delta' AND number = 6").get());

  const windowsAsked = () => asked.map(a => a.split(' ')[0]).filter((a, i, all) => all.indexOf(a) === i);
  asked.length = 0;
  await syncAuthoredPullRequests(db, { search, now: new Date(now.getTime() + PULL_REQUEST_RECHECK_MS + 60_000), cap: 3 });
  assert.deepEqual(windowsAsked(), ['2026-11-01..2026-11-30'],
    'the month still gaining merges is read again after the interval; October, read after it ended, is settled');

  asked.length = 0;
  await syncAuthoredPullRequests(db, { search, now: new Date('2026-12-02T12:00:00Z'), cap: 3 });
  assert.deepEqual(windowsAsked(), ['2026-11-01..2026-11-30', '2026-12-01..2026-12-31'],
    'a month last read before it ended is read once more, a day after');
  asked.length = 0;
  await syncAuthoredPullRequests(db, { search, now: new Date('2026-12-02T14:00:00Z'), cap: 3 });
  assert.deepEqual(windowsAsked(), ['2026-12-01..2026-12-31'], 'and then never again');
});

test('a window that returns fewer pull requests than the search counts stays unread, keeping what it returned', async () => {
  const pull = (number: number): AuthoredPullRequest => ({
    repo: 'owner/zeta', number, created_at: '2027-12-09T10:00:00Z', merged_at: '2027-12-09T10:00:00Z',
    additions: 1, deletions: 0, changed_files: 1, commit_count: 1, author_is_bot: false, commits: [`z-${number}`],
  });
  // One day holds more than the cap, so splitting cannot help; the search stops
  // at the cap, and repeats a result (as paging does when merges land meanwhile).
  const held = [1, 2, 3, 4].map(pull);
  const search: PullRequestSearch = async window => {
    const inWindow = window.from <= '2027-12-09' && window.to >= '2027-12-09' ? held : [];
    return { total: inWindow.length, pulls: [...inWindow.slice(0, 3), ...inWindow.slice(2, 3)], next: null, complete: true };
  };
  const report = await syncAuthoredPullRequests(db, { search, now: new Date('2028-01-15T00:00:00Z'), cap: 3 });
  assert.deepEqual([report.pull_requests, report.unanswered], [3, 1], 'four results, three of them distinct');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM github_pull_requests WHERE repo = 'owner/zeta'").get() as { n: number }).n, 3);
  assert.equal(db.prepare("SELECT 1 FROM github_pull_request_search WHERE window_start = '2027-12-01'").get(), undefined, 'December is short of its count');
  assert.ok(db.prepare("SELECT 1 FROM github_pull_request_search WHERE window_start = '2027-11-01'").get(), 'while a month that returned its count is read');
});
