import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database } from 'better-sqlite3';
import { pullRequestsOpenedBetween } from '../db/v2-queries.js';

const run = promisify(execFile);

/** A pull request a session opened, as its URL names it. */
export interface PullRequestKey {
  /** `owner/name`, lowercased. */
  repo: string;
  number: number;
}

export interface PullRequestState {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged_at: string | null;
  created_at: string | null;
  /** Its size and commits, when the answer carried them. */
  details?: PullRequestDetails;
  /**
   * The state answered but its details did not all (an error under it, or a
   * commit that did not resolve): nothing of them is recorded, and a merged
   * one is asked about again.
   */
  partial?: boolean;
}

/** A pull request's size, whether a bot opened it, and its commits (the first COMMITS_PER_PULL_REQUEST). */
export interface PullRequestDetails {
  additions: number;
  deletions: number;
  changed_files: number;
  commit_count: number;
  author_is_bot: boolean;
  commits: string[];
}

/**
 * Looks pull requests up on GitHub. The answer is keyed `owner/name#number`:
 * a state, null when GitHub has no such pull request, and no entry when it was
 * not answered (a failed request), so nothing is recorded for it.
 */
export type PullRequestLookup = (keys: PullRequestKey[]) => Promise<Map<string, PullRequestState | null>>;

export interface PullRequestSyncReport {
  checked: number;
  merged: number;
  unanswered: number;
}

/** An open or closed pull request is asked about again after this long; a merged one never is. */
export const PULL_REQUEST_RECHECK_MS = 60 * 60_000;
/** Pull requests per GraphQL request. */
const LOOKUP_BATCH = 50;
/** Commits read per pull request; a longer one keeps its count and its first this many. */
const COMMITS_PER_PULL_REQUEST = 100;
/** A pull request's fields beyond its state: size, author and commits. */
const DETAIL_FIELDS = `additions deletions changedFiles author { __typename } commits(first: ${COMMITS_PER_PULL_REQUEST}) { totalCount nodes { commit { oid } } }`;

interface DetailNode {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  author?: { __typename?: string } | null;
  commits?: { totalCount?: number; nodes?: Array<{ commit?: { oid?: string } } | null> };
}

/** Size, author and commits from a pull request's GraphQL node; undefined without them, or when a commit did not resolve. */
function detailsOf(node: DetailNode): PullRequestDetails | undefined {
  if (typeof node.additions !== 'number' || typeof node.commits?.totalCount !== 'number') return undefined;
  if ((node.commits.nodes ?? []).some(entry => typeof entry?.commit?.oid !== 'string')) return undefined;
  return {
    additions: node.additions,
    deletions: node.deletions ?? 0,
    changed_files: node.changedFiles ?? 0,
    commit_count: node.commits.totalCount,
    // A deleted account reads as null, not as a bot.
    author_is_bot: node.author?.__typename === 'Bot',
    commits: (node.commits.nodes ?? []).map(entry => entry!.commit!.oid!),
  };
}
const GH_TIMEOUT_MS = 60_000;
/** How far back sessions' pull requests are checked, as far as git activity reads. */
const SESSION_HISTORY_MS = 365 * 86_400_000;

export const pullRequestKey = (key: PullRequestKey) => `${key.repo}#${key.number}`;

/** One GraphQL query for a batch, with the alias each answer comes back under. */
export function lookupQuery(keys: PullRequestKey[]): { query: string; aliases: Map<string, string> } {
  const byRepo = new Map<string, Set<number>>();
  for (const key of keys) {
    // Names come from URLs that admit only these characters; anything else is
    // never written into the query.
    if (!/^[\w.-]+\/[\w.-]+$/.test(key.repo) || !Number.isSafeInteger(key.number)) continue;
    const numbers = byRepo.get(key.repo) ?? new Set();
    byRepo.set(key.repo, numbers.add(key.number));
  }
  const aliases = new Map<string, string>();
  const repositories = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split('/');
    const pulls = [...numbers].map(number => {
      aliases.set(`r${index}.p${number}`, pullRequestKey({ repo, number }));
      return `p${number}: pullRequest(number: ${number}) { state mergedAt createdAt ${DETAIL_FIELDS} }`;
    });
    return `r${index}: repository(owner: "${owner}", name: "${name}") { ${pulls.join(' ')} }`;
  });
  return { query: `query { ${repositories.join(' ')} }`, aliases };
}

/** States from a GraphQL response, which keeps the data it could answer beside its errors. */
export function parseLookupResponse(body: string, aliases: Map<string, string>): Map<string, PullRequestState | null> {
  const answers = new Map<string, PullRequestState | null>();
  let parsed: {
    data?: Record<string, Record<string, ({ state?: string; mergedAt?: string | null; createdAt?: string | null } & DetailNode) | null> | null>;
    errors?: Array<{ type?: string; path?: string[] }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return answers;
  }
  // Null is an answer only where GitHub said it found nothing; a null left by
  // any other error (permissions, limits) is no answer.
  const notFound = new Set((parsed.errors ?? []).filter(error => error.type === 'NOT_FOUND').map(error => (error.path ?? []).join('.')));
  for (const [alias, key] of aliases) {
    const [repoAlias, pullAlias] = alias.split('.');
    const repository = parsed.data?.[repoAlias];
    if (repository === null) {
      if (notFound.has(repoAlias)) answers.set(key, null);
      continue;
    }
    const pull = repository?.[pullAlias];
    if (pull === null) {
      if (notFound.has(alias)) answers.set(key, null);
      continue;
    }
    if (pull?.state === 'OPEN' || pull?.state === 'CLOSED' || pull?.state === 'MERGED') {
      const state: PullRequestState = { state: pull.state, merged_at: pull.mergedAt ?? null, created_at: pull.createdAt ?? null };
      const details = detailsOf(pull);
      const erred = (parsed.errors ?? []).some(error => error.path?.[0] === repoAlias && error.path?.[1] === pullAlias);
      if (erred || (pull.commits !== undefined && !details)) answers.set(key, { ...state, partial: true });
      else answers.set(key, { ...state, ...(details ? { details } : {}) });
    }
  }
  return answers;
}

/** Ask GitHub through the `gh` CLI, read-only, as its signed-in user. */
const ghPullRequestLookup: PullRequestLookup = async keys => {
  const answers = new Map<string, PullRequestState | null>();
  for (let start = 0; start < keys.length; start += LOOKUP_BATCH) {
    const { query, aliases } = lookupQuery(keys.slice(start, start + LOOKUP_BATCH));
    if (aliases.size === 0) continue;
    let body: string;
    try {
      body = (await run('gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (err) {
      // `gh` exits 1 when any part of the query found nothing, still printing
      // the data it resolved; without that output the batch went unanswered.
      body = (err as { stdout?: string }).stdout ?? '';
    }
    for (const [key, state] of parseLookupResponse(body, aliases)) answers.set(key, state);
  }
  return answers;
};

/**
 * Record on GitHub's word whether the pull requests sessions opened were
 * merged, which local git alone shows for only some: a squash merged on
 * GitHub, or one never pulled, leaves no commit here. Asks only about those
 * not known merged and not asked within PULL_REQUEST_RECHECK_MS.
 */
export async function syncPullRequestStates(
  db: Database,
  keys: PullRequestKey[],
  options: { lookup?: PullRequestLookup; now?: Date } = {},
): Promise<PullRequestSyncReport> {
  const now = options.now ?? new Date();
  const lookup = options.lookup ?? ghPullRequestLookup;
  const known = db.prepare('SELECT state, checked_at, details_at FROM github_pull_requests WHERE repo = ? AND number = ?');
  const due = new Map<string, PullRequestKey>();
  for (const key of keys) {
    const row = known.get(key.repo, key.number) as { state: string | null; checked_at: string; details_at: string | null } | undefined;
    // Merged is final once its details are read; one stored before they were is asked once more.
    if (row?.state === 'MERGED' && row.details_at !== null) continue;
    if (row?.state === 'MERGED' && row.details_at === null) {
      due.set(pullRequestKey(key), key);
      continue;
    }
    if (row && now.getTime() - Date.parse(row.checked_at) < PULL_REQUEST_RECHECK_MS) continue;
    due.set(pullRequestKey(key), key);
  }
  const report: PullRequestSyncReport = { checked: due.size, merged: 0, unanswered: 0 };
  if (due.size === 0) return report;

  const answers = await lookup([...due.values()]);
  const record = recorder(db);
  db.transaction(() => {
    for (const [id, key] of due) {
      if (!answers.has(id)) {
        report.unanswered += 1;
        continue;
      }
      const answer = answers.get(id) ?? null;
      if (answer?.state === 'MERGED') report.merged += 1;
      record(key, answer, now);
    }
  })();
  return report;
}

/**
 * Store one answer: its state, and its size, author and commits when it
 * carried them. GitHub's commit list replaces any found from a local merge.
 * details_at is set by any answer but a partial one, so one without details
 * is not asked again for them, and a partial one is.
 */
function recorder(db: Database): (key: PullRequestKey, answer: PullRequestState | null, now: Date) => void {
  const upsert = db.prepare(`
    INSERT INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at,
      additions, deletions, changed_files, commit_count, author_is_bot, details_at)
    VALUES (@repo, @number, @state, @merged_at, @created_at, @now, @additions, @deletions, @changed_files, @commit_count, @author_is_bot, @details_at)
    ON CONFLICT(repo, number) DO UPDATE SET
      state = excluded.state, merged_at = excluded.merged_at, created_at = excluded.created_at, checked_at = excluded.checked_at,
      additions = COALESCE(excluded.additions, github_pull_requests.additions),
      deletions = COALESCE(excluded.deletions, github_pull_requests.deletions),
      changed_files = COALESCE(excluded.changed_files, github_pull_requests.changed_files),
      commit_count = COALESCE(excluded.commit_count, github_pull_requests.commit_count),
      author_is_bot = COALESCE(excluded.author_is_bot, github_pull_requests.author_is_bot),
      details_at = excluded.details_at
  `);
  const clearCommits = db.prepare('DELETE FROM github_pull_request_commits WHERE repo = ? AND number = ?');
  const addCommit = db.prepare("INSERT OR IGNORE INTO github_pull_request_commits (repo, number, sha, source) VALUES (?, ?, ?, 'github')");
  return (key, answer, now) => {
    const details = answer?.details;
    upsert.run({
      repo: key.repo, number: key.number, state: answer?.state ?? null, merged_at: answer?.merged_at ?? null,
      created_at: answer?.created_at ?? null, now: now.toISOString(),
      additions: details?.additions ?? null, deletions: details?.deletions ?? null, changed_files: details?.changed_files ?? null,
      commit_count: details?.commit_count ?? null, author_is_bot: details ? Number(details.author_is_bot) : null,
      details_at: answer?.partial ? null : now.toISOString(),
    });
    if (!details) return;
    clearCommits.run(key.repo, key.number);
    for (const sha of details.commits) addCommit.run(key.repo, key.number, sha);
  };
}

/** Check the pull requests sessions opened in the last year against GitHub. */
export function syncSessionPullRequests(
  db: Database,
  options: { lookup?: PullRequestLookup; now?: Date } = {},
): Promise<PullRequestSyncReport> {
  const now = options.now ?? new Date();
  return syncPullRequestStates(db, pullRequestsOpenedBetween(now.getTime() - SESSION_HISTORY_MS, now.getTime()), { ...options, now });
}

/** A merged pull request the signed-in user authored, as GitHub's search returns it. */
export interface AuthoredPullRequest extends PullRequestKey, PullRequestDetails {
  merged_at: string;
  created_at: string;
}

/**
 * One page of the search: how many the window holds, this page's pull
 * requests, the next page's cursor, and whether every result on it answered.
 */
export interface PullRequestSearchPage {
  total: number;
  pulls: AuthoredPullRequest[];
  next: string | null;
  complete: boolean;
}

/**
 * Searches the signed-in user's pull requests merged on the days `from` to
 * `to` (inclusive, `YYYY-MM-DD`). Null when GitHub did not answer.
 */
export type PullRequestSearch = (window: { from: string; to: string }, after: string | null) => Promise<PullRequestSearchPage | null>;

export interface AuthoredPullRequestReport {
  windows: number;
  pull_requests: number;
  unanswered: number;
}

/** Results GitHub's search returns at most for one query; a window holding more is split. */
const SEARCH_RESULT_CAP = 1000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Pull requests per search page. With each one's commits, a page of GitHub's
 * most (100) timed out as HTTP 502 on a month of a few hundred; 25 read the
 * same months whole, at a few seconds a page (measured 2026-11-03).
 */
const SEARCH_PAGE = 25;
/** How long after a month ends its last read waits, for merges the search had not indexed yet. */
const SEARCH_SETTLE_MS = 86_400_000;

/** The query for one page of a window's merged pull requests by the signed-in user. */
export function searchQuery(window: { from: string; to: string }, after: string | null): string {
  // Days are written into the search string, so only a day may be.
  if (!DAY_PATTERN.test(window.from) || !DAY_PATTERN.test(window.to)) throw new Error(`Not a search window: ${JSON.stringify(window)}`);
  const search = `is:pr is:merged author:@me merged:${window.from}..${window.to}`;
  const page = after === null ? '' : `after: ${JSON.stringify(after)}, `;
  return `query { search(type: ISSUE, first: ${SEARCH_PAGE}, ${page}query: ${JSON.stringify(search)}) { issueCount pageInfo { hasNextPage endCursor } `
    + `nodes { ... on PullRequest { number repository { nameWithOwner } createdAt mergedAt ${DETAIL_FIELDS} } } } }`;
}

/**
 * One page from a search response; null when it holds no answer (an error, or
 * not JSON). A page with an error or a result that did not answer is incomplete.
 */
export function parseSearchResponse(body: string): PullRequestSearchPage | null {
  let parsed: {
    data?: { search?: {
      issueCount?: number;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<({ number?: number; repository?: { nameWithOwner?: string }; createdAt?: string; mergedAt?: string } & DetailNode) | null>;
    } | null } | null;
    errors?: unknown[];
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const search = parsed.data?.search;
  if (!search || typeof search.issueCount !== 'number') return null;
  const pulls: AuthoredPullRequest[] = [];
  // GitHub answers what it can beside its errors; a page with any is kept but not whole.
  let complete = !parsed.errors?.length;
  for (const node of search.nodes ?? []) {
    const repo = node?.repository?.nameWithOwner?.toLowerCase();
    const details = node ? detailsOf(node) : undefined;
    if (!node || !repo || typeof node.number !== 'number' || !node.mergedAt || !node.createdAt || !details) {
      complete = false;
      continue;
    }
    pulls.push({ repo, number: node.number, created_at: node.createdAt, merged_at: node.mergedAt, ...details });
  }
  return { total: search.issueCount, pulls, next: search.pageInfo?.hasNextPage ? search.pageInfo.endCursor ?? null : null, complete };
}

/** Search GitHub through the `gh` CLI, read-only, as its signed-in user. */
const ghPullRequestSearch: PullRequestSearch = async (window, after) => {
  let body: string;
  try {
    body = (await run('gh', ['api', 'graphql', '-f', `query=${searchQuery(window, after)}`], { timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    body = (err as { stdout?: string }).stdout ?? '';
  }
  return parseSearchResponse(body);
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Every pull request a window holds, splitting it while it holds more than the
 * cap. `complete` is false when a page went unanswered or answered in part,
 * or the pages held fewer pull requests than the search counted; what was
 * read is kept.
 */
async function readWindow(
  search: PullRequestSearch, window: { from: string; to: string }, cap: number,
): Promise<{ total: number; pulls: AuthoredPullRequest[]; complete: boolean }> {
  const first = await search(window, null);
  if (!first) return { total: 0, pulls: [], complete: false };
  const from = Date.parse(`${window.from}T00:00:00Z`);
  const to = Date.parse(`${window.to}T00:00:00Z`);
  if (first.total > cap && to > from) {
    const mid = from + Math.floor((to - from) / DAY_MS / 2) * DAY_MS;
    const halves = await Promise.all([{ from: window.from, to: day(mid) }, { from: day(mid + DAY_MS), to: window.to }]
      .map(half => readWindow(search, half, cap)));
    return {
      total: halves[0].total + halves[1].total,
      pulls: [...halves[0].pulls, ...halves[1].pulls],
      complete: halves[0].complete && halves[1].complete,
    };
  }
  // A single day over the cap is read as far as the search will go.
  const pulls = [...first.pulls];
  let complete = first.complete;
  for (let next = first.next; next !== null;) {
    const page = await search(window, next);
    if (!page) return { total: first.total, pulls, complete: false };
    pulls.push(...page.pulls);
    complete &&= page.complete;
    next = page.next;
  }
  // Fewer than the search counts (a day over the cap, or results it skipped) is not whole.
  const read = new Set(pulls.map(pullRequestKey)).size;
  return { total: first.total, pulls, complete: complete && read >= first.total };
}

/**
 * Record the pull requests the signed-in user merged in the last year, with
 * their size and commits, so work no session here opened (another machine,
 * or a pull request opened by hand) is known too, and coverage can be
 * measured against all of it. Reads month by month. The current month, which
 * still gains merges, is read again after PULL_REQUEST_RECHECK_MS; an ended
 * month once more on the first pass SEARCH_SETTLE_MS after its end, then never.
 * A month counts as read only when every page of it answered.
 */
export async function syncAuthoredPullRequests(
  db: Database,
  options: { search?: PullRequestSearch; now?: Date; cap?: number } = {},
): Promise<AuthoredPullRequestReport> {
  const now = options.now ?? new Date();
  const search = options.search ?? ghPullRequestSearch;
  const cap = options.cap ?? SEARCH_RESULT_CAP;
  const report: AuthoredPullRequestReport = { windows: 0, pull_requests: 0, unanswered: 0 };
  const read = db.prepare('SELECT synced_at FROM github_pull_request_search WHERE window_start = ?');
  const markRead = db.prepare(`
    INSERT INTO github_pull_request_search (window_start, window_end, result_count, synced_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(window_start) DO UPDATE SET window_end = excluded.window_end, result_count = excluded.result_count, synced_at = excluded.synced_at
  `);
  const record = recorder(db);

  const start = new Date(now.getTime() - SESSION_HISTORY_MS);
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  for (let month = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1); month <= thisMonth;) {
    const next = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1);
    const window = { from: day(month), to: day(next - DAY_MS) };
    const previous = read.get(window.from) as { synced_at: string } | undefined;
    const settled = previous !== undefined && Date.parse(previous.synced_at) >= next + SEARCH_SETTLE_MS;
    month = next;
    if (previous && (settled || now.getTime() - Date.parse(previous.synced_at) < PULL_REQUEST_RECHECK_MS)) continue;

    const result = await readWindow(search, window, cap);
    db.transaction(() => {
      for (const pull of result.pulls) {
        record(pull, { state: 'MERGED', merged_at: pull.merged_at, created_at: pull.created_at, details: pull }, now);
      }
      if (result.complete) markRead.run(window.from, window.to, result.total, now.toISOString());
    })();
    report.pull_requests += new Set(result.pulls.map(pullRequestKey)).size;
    if (result.complete) report.windows += 1;
    else report.unanswered += 1;
  }
  return report;
}
