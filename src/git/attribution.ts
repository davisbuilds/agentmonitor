// Which session made a commit, decided from evidence a session leaves, never
// from timing alone. Pure, so each rule is testable without a store.

/** A `git commit` a session ran, timed by the message that ran it. */
export interface CommitCall {
  session_id: string;
  agent: string;
  /** Epoch ms. */
  at: number;
  /** The call's input, as stored. */
  input: string;
  /** The call's result text, as stored; empty when none was kept. */
  result: string;
}

export interface CommitFact {
  sha: string;
  subject: string;
  /** Epoch ms of the commit's author date. */
  at: number;
}

export type CommitAttribution =
  | { kind: 'session'; session_id: string; agent: string; evidence: 'hash' | 'subject' }
  /** A session committed close by, but none proved this commit. Not counted as anyone's. */
  | { kind: 'time_only' }
  /** No session committed close by: made outside any session amon has. */
  | { kind: 'outside' };

/** A commit's call ran within this long of its author date. */
export const COMMIT_CALL_WINDOW_MS = 2 * 60_000;
/** How long before its commit a session may have written the message (a `-F` file). */
const MESSAGE_LEAD_MS = 15 * 60_000;
/** How long after a call a poll of a process it left running still carries that call's output. */
export const PROCESS_POLL_WINDOW_MS = 30 * 60_000;
const SUBJECT_PROBE_LENGTH = 50;

/** Ways a subject can appear in a stored input: raw, or escaped once or twice for JSON. */
function subjectProbes(subject: string): string[] {
  const head = subject.slice(0, SUBJECT_PROBE_LENGTH);
  if (!head.trim()) return [];
  const once = JSON.stringify(head).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [...new Set([head, once, twice])];
}

function mentionsSubject(text: string, subject: string): boolean {
  return subjectProbes(subject).some(probe => text.includes(probe));
}

/**
 * The session that made a commit, by the strongest evidence among the sessions
 * that ran `git commit` within the window: its result names the commit's hash
 * (Codex prints `[branch abc1234]`), or its command, or a call it made in the
 * minutes before, carries the commit's subject (`-m`, or a message file for
 * `-F`). Evidence that points at two sessions proves neither.
 *
 * `earlierInputs` returns a session's call inputs from MESSAGE_LEAD_MS before
 * the commit to the window's end; it is asked only when no call proves the
 * commit outright.
 */
export function attributeCommit(
  commit: CommitFact,
  calls: CommitCall[],
  earlierInputs: (sessionId: string, from: number, to: number) => string[],
): CommitAttribution {
  const candidates = calls.filter(call => Math.abs(call.at - commit.at) <= COMMIT_CALL_WINDOW_MS);
  if (candidates.length === 0) return { kind: 'outside' };

  const shortSha = commit.sha.slice(0, 7);
  const proof = (match: (call: CommitCall) => boolean, evidence: 'hash' | 'subject'): CommitAttribution | null => {
    const sessions = new Map(candidates.filter(match).map(call => [call.session_id, call.agent]));
    if (sessions.size !== 1) return null;
    const [[session_id, agent]] = sessions;
    return { kind: 'session', session_id, agent, evidence };
  };
  const proven = proof(call => call.result.includes(shortSha), 'hash')
    ?? proof(call => mentionsSubject(call.input, commit.subject), 'subject');
  if (proven) return proven;

  const bySessions = new Map(candidates.map(call => [call.session_id, call.agent]));
  const wrote = [...bySessions].filter(([sessionId]) => earlierInputs(sessionId, commit.at - MESSAGE_LEAD_MS, commit.at + COMMIT_CALL_WINDOW_MS)
    .some(input => mentionsSubject(input, commit.subject)));
  if (wrote.length === 1) return { kind: 'session', session_id: wrote[0][0], agent: wrote[0][1], evidence: 'subject' };
  return { kind: 'time_only' };
}

/**
 * Processes a Codex call left running when its result came back: the rest of
 * their output, a `gh pr create` URL or a commit line, arrives in later polls.
 * Native calls say `Process running with session ID N`; code mode returns a
 * chunk carrying `"session_id":N`, escaped once more inside the stored result.
 */
export function runningProcessIds(result: string): string[] {
  const ids = new Set<string>();
  for (const match of result.matchAll(/Process running with session ID (\d+)/g)) ids.add(match[1]);
  for (const match of result.matchAll(/\\*"session_id\\*"\s*:\s*(\d+)/g)) ids.add(match[1]);
  return [...ids];
}

/** Whether a call polls one of a session's processes: `write_stdin`, called as a tool or from a script. */
export function pollsProcess(toolName: string, input: string, id: string): boolean {
  if (toolName !== 'write_stdin' && !input.includes('write_stdin')) return false;
  return new RegExp(`(?<!\\d)${id}(?!\\d)`).test(input);
}

export interface PullRequestRef {
  /** `owner/name`, lowercased. */
  repo: string;
  number: number;
  url: string;
}

// A link with a fragment (`#issuecomment-…`, `#discussion_r…`) points into a
// pull request that already exists, as a `gh pr comment` in the same script
// prints; it opened nothing.
const PULL_REQUEST_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?![\d#])/g;

/** The pull requests a `gh pr create` result names, in order, once each. */
export function pullRequestUrls(text: string): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  for (const match of text.matchAll(PULL_REQUEST_URL)) {
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    const number = Number(match[3]);
    const key = `${repo}#${number}`;
    if (!found.has(key)) found.set(key, { repo, number, url: `https://github.com/${match[1]}/${match[2]}/pull/${number}` });
  }
  return [...found.values()];
}

/**
 * The pull request a commit on the default branch merged: GitHub's merge
 * commit ("Merge pull request #N from ...") or a squash merge's subject
 * ("... (#N)"). Null for any other commit.
 */
export function mergedPullRequestNumber(subject: string, isMerge: boolean): number | null {
  const merge = isMerge ? /^Merge pull request #(\d+) from /.exec(subject) : null;
  const squash = isMerge ? null : /\(#(\d+)\)$/.exec(subject.trim());
  const match = merge ?? squash;
  return match ? Number(match[1]) : null;
}

/** `owner/name` of a GitHub remote URL, lowercased; null for any other host. */
export function githubRepoOfRemote(url: string): string | null {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
