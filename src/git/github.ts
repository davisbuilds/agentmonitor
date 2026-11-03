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
      return `p${number}: pullRequest(number: ${number}) { state mergedAt createdAt }`;
    });
    return `r${index}: repository(owner: "${owner}", name: "${name}") { ${pulls.join(' ')} }`;
  });
  return { query: `query { ${repositories.join(' ')} }`, aliases };
}

/** States from a GraphQL response, which keeps the data it could answer beside its errors. */
export function parseLookupResponse(body: string, aliases: Map<string, string>): Map<string, PullRequestState | null> {
  const answers = new Map<string, PullRequestState | null>();
  let parsed: {
    data?: Record<string, Record<string, { state?: string; mergedAt?: string | null; createdAt?: string | null } | null> | null>;
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
      answers.set(key, { state: pull.state, merged_at: pull.mergedAt ?? null, created_at: pull.createdAt ?? null });
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
  const known = db.prepare('SELECT state, checked_at FROM github_pull_requests WHERE repo = ? AND number = ?');
  const due = new Map<string, PullRequestKey>();
  for (const key of keys) {
    const row = known.get(key.repo, key.number) as { state: string | null; checked_at: string } | undefined;
    if (row?.state === 'MERGED') continue;
    if (row && now.getTime() - Date.parse(row.checked_at) < PULL_REQUEST_RECHECK_MS) continue;
    due.set(pullRequestKey(key), key);
  }
  const report: PullRequestSyncReport = { checked: due.size, merged: 0, unanswered: 0 };
  if (due.size === 0) return report;

  const answers = await lookup([...due.values()]);
  const record = db.prepare(`
    INSERT INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, number) DO UPDATE SET
      state = excluded.state, merged_at = excluded.merged_at, created_at = excluded.created_at, checked_at = excluded.checked_at
  `);
  db.transaction(() => {
    for (const [id, key] of due) {
      if (!answers.has(id)) {
        report.unanswered += 1;
        continue;
      }
      const answer = answers.get(id) ?? null;
      if (answer?.state === 'MERGED') report.merged += 1;
      record.run(key.repo, key.number, answer?.state ?? null, answer?.merged_at ?? null, answer?.created_at ?? null, now.toISOString());
    }
  })();
  return report;
}

/** Check the pull requests sessions opened in the last year against GitHub. */
export function syncSessionPullRequests(
  db: Database,
  options: { lookup?: PullRequestLookup; now?: Date } = {},
): Promise<PullRequestSyncReport> {
  const now = options.now ?? new Date();
  return syncPullRequestStates(db, pullRequestsOpenedBetween(now.getTime() - SESSION_HISTORY_MS, now.getTime()), { ...options, now });
}
