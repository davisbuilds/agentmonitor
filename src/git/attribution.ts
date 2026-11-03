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
  /** The directory the session started in, and the project it names; null without either. */
  cwd: string | null;
  project: string | null;
}

export interface CommitFact {
  sha: string;
  subject: string;
  /** Epoch ms of the commit's author date. */
  at: number;
  /** Epoch ms of its committer date: when it was created, which an amend or a rebase moves and the author date keeps. */
  committed_at: number;
  /** The repository's top directory, and the project it names. */
  repo_root: string;
  project: string;
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


// An option git takes before its command: `-C <path>` or `-c <key>=<value>`
// (a path possibly quoted, and escaped once more in stored JSON), or a flag.
const GIT_GLOBAL_OPTION = String.raw`(?:-[Cc]\s+(?:\\?"[^"\\]*\\?"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?|-[a-zA-Z])`;
// `git` starts a word, or a line of a script stored as JSON (`\ngit`).
const GIT_COMMIT = new RegExp(String.raw`(?:(?<![\w-])|(?<=\\[nt]))git(?:\s+${GIT_GLOBAL_OPTION})*\s+commit(?![\w-])`);

/** Whether a command runs `git commit`, global options (`-C <path>`, `-c <key>=<value>`, `--no-pager`) included. */
export function runsGitCommit(input: string): boolean {
  return GIT_COMMIT.test(input);
}

/** Whether a result shows git creating this commit: its `[branch abc1234] subject` line, not a hash a log printed. */
export function createdCommit(result: string, sha: string): boolean {
  for (const match of result.matchAll(/\[[^\]\n]* ([0-9a-f]{7,40})\]/g)) {
    if (sha.startsWith(match[1])) return true;
  }
  return false;
}

// Quotes and escapes, which shells and stored JSON (once or twice) spell
// differently around the same text, collapse to one marker on both sides.
const QUOTING = /[\\"'`]+/g;
const MARK = '\0';

/**
 * Whether a call's input carries a commit's whole subject: however it was
 * quoted or escaped, and ending where the subject ends (a quote, an escape
 * such as `\n`, a newline, or the end), not the opening of a longer one.
 */
function mentionsSubject(text: string, subject: string): boolean {
  const probe = subject.replace(QUOTING, MARK).replace(/^\0+|\0+$/g, '');
  if (!probe.trim()) return false;
  const haystack = text.replace(QUOTING, MARK);
  for (let from = 0; ;) {
    const index = haystack.indexOf(probe, from);
    if (index === -1) return false;
    const next = haystack[index + probe.length];
    if (next === undefined || next === MARK || next === '\n') return true;
    from = index + 1;
  }
}

/**
 * Whether a call's text reaches a commit's repository: its top directory, a
 * path ending in its name, or one of its worktrees (`worktrees/<name>-…`), as
 * a session started in a folder of projects names the one it commits in.
 */
function namesRepository(text: string, commit: CommitFact): boolean {
  if (text.includes(commit.repo_root)) return true;
  const name = commit.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/${name}(?![\\w.-])|worktrees/${name}-`).test(text);
}

/**
 * The session that made a commit, by the strongest evidence among the sessions
 * that ran `git commit` within the window, tried in order:
 * 1. Its result shows git creating the commit (`[branch abc1234] subject`).
 * 2. Its command carries the commit's subject (`-m`).
 * 3. A call it made in the minutes before carries the subject (a message
 *    file for `-F`).
 * A subject proves a session only for a commit in the repository it worked
 * in: the one its directory is in or names (a worktree), or one its calls name. Where the strongest
 * evidence found points at two sessions, it proves neither, and weaker
 * evidence is not consulted.
 *
 * A call is a candidate when it ran within the window of the commit's author
 * date or its committer date. `earlierInputs` returns a session's call inputs
 * between two instants: from MESSAGE_LEAD_MS before either date for its
 * message, and from the start for the repository it reached. It is asked only when no hash proves the commit.
 */
export function attributeCommit(
  commit: CommitFact,
  calls: CommitCall[],
  earlierInputs: (sessionId: string, from: number, to: number) => string[],
): CommitAttribution {
  // The call that made a commit ran by its committer date, which an amend
  // moves; a rebase moves it too, leaving the original call by its author date.
  const times = [...new Set([commit.at, commit.committed_at])];
  const candidates = calls.filter(call => times.some(time => Math.abs(call.at - time) <= COMMIT_CALL_WINDOW_MS));
  if (candidates.length === 0) return { kind: 'outside' };

  const sessionsOf = (matching: Array<{ session_id: string; agent: string }>) =>
    new Map(matching.map(call => [call.session_id, call.agent]));
  const verdict = (sessions: Map<string, string>, evidence: 'hash' | 'subject'): CommitAttribution | null => {
    if (sessions.size === 0) return null;
    if (sessions.size > 1) return { kind: 'time_only' };
    const [[session_id, agent]] = sessions;
    return { kind: 'session', session_id, agent, evidence };
  };

  const byHash = verdict(sessionsOf(candidates.filter(call => createdCommit(call.result, commit.sha))), 'hash');
  if (byHash) return byHash;

  // A session works in the commit's repository when it started there (or in
  // one of its worktrees), or when a call of its names the repository: the
  // commit call, or any call before it, since the shell keeps the directory an
  // earlier `cd` moved it to.
  const end = Math.max(...times) + COMMIT_CALL_WINDOW_MS;
  const reached = new Map<string, boolean>();
  const reaches = (sessionId: string): boolean => {
    let found = reached.get(sessionId);
    if (found === undefined) {
      found = candidates.some(call => call.session_id === sessionId && (
        (call.cwd !== null && (call.cwd === commit.repo_root || call.cwd.startsWith(`${commit.repo_root}/`)))
        || (call.project !== null && call.project === commit.project)
        || namesRepository(call.input, commit)))
        || earlierInputs(sessionId, 0, end).some(input => namesRepository(input, commit));
      reached.set(sessionId, found);
    }
    return found;
  };
  const bySubject = verdict(sessionsOf(candidates.filter(call => mentionsSubject(call.input, commit.subject) && reaches(call.session_id))), 'subject');
  if (bySubject) return bySubject;

  const wrote = [...sessionsOf(candidates)].filter(([sessionId]) =>
    times.some(time => earlierInputs(sessionId, time - MESSAGE_LEAD_MS, time + COMMIT_CALL_WINDOW_MS).some(input => mentionsSubject(input, commit.subject)))
    && reaches(sessionId))
    .map(([session_id, agent]) => ({ session_id, agent }));
  return verdict(sessionsOf(wrote), 'subject') ?? { kind: 'time_only' };
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
  // `session_id: N`, its key quoted or not and escaped as stored, or a loop
  // over a list of ids passing a variable (`for (const id of [N, M])`).
  const argument = new RegExp(String.raw`session_id\\*"?\s*:\s*${id}(?!\d)`);
  const loop = new RegExp(String.raw`session_id\\*"?\s*:\s*[A-Za-z_]`).test(input)
    && new RegExp(String.raw`\[[\d,\s]*(?<!\d)${id}(?!\d)[\d,\s]*\]`).test(input);
  return argument.test(input) || loop;
}

/** Code-mode cells a Codex call yielded (`Script running with cell ID N`), whose output a later `wait` returns. */
export function yieldedCellIds(result: string): string[] {
  return [...new Set([...result.matchAll(/Script running with cell ID (\d+)/g)].map(match => match[1]))];
}

/** Whether a call waits on one of a session's yielded cells. */
export function waitsOnCell(toolName: string, input: string, id: string): boolean {
  return toolName === 'wait' && new RegExp(String.raw`\\*"cell_id\\*"\s*:\s*\\*"?${id}(?!\d)`).test(input);
}

/** Whether a command runs `gh pr create`, with `-R`/`--repo` before or after `pr`. */
const GH_REPO_FLAG = String.raw`(?:\s+(?:-R|--repo)(?:\s+|=)\S+)*`;
const GH_PR_CREATE = new RegExp(String.raw`(?:(?<![\w-])|(?<=\\[nt]))gh${GH_REPO_FLAG}\s+pr${GH_REPO_FLAG}\s+create(?![\w-])`);

export function opensPullRequest(input: string): boolean {
  return GH_PR_CREATE.test(input);
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

/** Whether a tool creates a pull request itself: a GitHub app's or MCP server's `create_pull_request`. */
export function isPullRequestTool(toolName: string): boolean {
  return /(?:^|[_.-])create_pull_request$/i.test(toolName);
}

/**
 * The string fields at the top level of a JSON object, read in order and
 * tolerating a cut-off end: a stored result keeps only its first part, and the
 * fields a tool returns first (GitHub's `url`) survive the cut while the body
 * after them may not.
 */
function topLevelStrings(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const start = text.indexOf('{');
  if (start === -1) return fields;
  let depth = 0;
  let key: string | null = null;
  let expectValue = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      // A whole string: the JSON escapes in it end at its closing quote.
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) break;
      let value: string;
      try {
        value = JSON.parse(text.slice(index, end + 1)) as string;
      } catch {
        break;
      }
      if (depth === 1 && expectValue && key !== null) fields.set(key, value);
      else if (depth === 1 && !expectValue) key = value;
      expectValue = false;
      index = end;
    } else if (char === ':' && depth === 1) expectValue = true;
    else if (char === ',' && depth === 1) { key = null; expectValue = false; }
    else if (char === '{' || char === '[') { depth += 1; expectValue = false; }
    else if (char === '}' || char === ']') { depth -= 1; if (depth === 0) break; }
  }
  return fields;
}

/**
 * The pull request a GitHub tool's result says it created: the `html_url` or
 * `url` of the object it returned, read from the object's own top level. The
 * stored result wraps that object (a string after `Output:`, or MCP text
 * blocks), so it is unwrapped rather than searched: a body quoting other pull
 * requests, even as JSON, is not read.
 */
export function createdPullRequestUrls(result: string): PullRequestRef[] {
  const texts: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      texts.push(value);
      // A wrapper serialized into a string (an MCP result in a receipt's content).
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          collect(JSON.parse(trimmed), depth + 1);
        } catch {
          // Not JSON, or cut off: read as text.
        }
      }
    }
    else if (Array.isArray(value)) value.forEach(item => collect((item as { text?: unknown } | null)?.text, depth + 1));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.url === 'string' || typeof record.html_url === 'string') texts.push(JSON.stringify(record));
      else for (const key of ['content', 'output', 'text']) collect(record[key], depth + 1);
    }
  };
  try {
    collect(JSON.parse(result));
  } catch {
    texts.push(result);
  }
  for (const text of texts) {
    const output = text.lastIndexOf('Output:\n');
    const fields = topLevelStrings(output === -1 ? text : text.slice(output + 'Output:\n'.length));
    for (const field of ['html_url', 'url']) {
      const url = fields.get(field);
      if (url === undefined) continue;
      const refs = pullRequestUrls(url);
      if (refs.length === 1 && refs[0].url.length === url.replace(/\/$/, '').length) return refs;
    }
  }
  return [];
}

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
