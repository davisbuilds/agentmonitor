import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-git-analytics-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);

const root = path.join(tempDir, 'alpha');
const at = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 2, 2, hour, minute, second)).toISOString();
db.prepare("INSERT INTO git_repos (root, last_scanned_at, github_repo) VALUES (?, ?, 'owner/alpha')").run(root, at(23));
const commitRow = db.prepare(`INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, author_name, author_email, subject, co_authors_json, is_merge)
  VALUES (?, ?, ?, ?, 'Dev', 'dev@example.com', ?, ?, ?)`);
const addCommit = (sha: string, when: string, subject: string, coAuthors: string[] = [], isMerge = 0) =>
  commitRow.run(root, sha, when, when, subject, JSON.stringify(coAuthors), isMerge);

const session = db.prepare(`INSERT INTO browsing_sessions (id, agent, integration_mode, cwd, title, started_at, ended_at, message_count, user_message_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, 10, 1)`);
let ordinal = 0;
const message = db.prepare('INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, \'assistant\', \'[]\', ?)');
const call = db.prepare('INSERT INTO tool_calls (message_id, session_id, tool_name, tool_use_id, input_json) VALUES (?, ?, ?, ?, ?)');
const result = db.prepare("INSERT INTO session_items (session_id, ordinal, source_item_id, kind, status, payload_json) VALUES (?, 0, ?, 'tool_result', 'success', ?)");
function runs(sessionId: string, when: string, command: string, callId: string, output?: { row: string; id: string }) {
  const messageId = Number(message.run(sessionId, ordinal++, when).lastInsertRowid);
  call.run(messageId, sessionId, 'Bash', callId, JSON.stringify({ command }));
  if (output) result.run(output.row, output.id, JSON.stringify({ content: command.startsWith('gh pr create') ? output.row === sessionId ? prUrl(7) : prUrl(8) : '[main bbb2222] fix: two' }));
}
const prUrl = (n: number) => `https://github.com/owner/alpha/pull/${n}`;

// Claude, proven by the subject in its command; it opened #7, which merged.
session.run('c1', 'claude', 'claude-jsonl', root, 'Ship one', at(9), at(10, 30), );
runs('c1', at(10), 'git commit -m "feat: one"', 'toolu_c1');
addCommit('aaa1111aaaa', at(10, 0, 30), 'feat: one', ['Claude Opus 5.5 <noreply@anthropic.com>']);
runs('c1', at(10, 5), 'gh pr create --fill', 'toolu_pr7', { row: 'c1', id: 'toolu_pr7' });
addCommit('eee5555eeee', at(20), 'Merge pull request #7 from owner/feat-one', [], 1);

// Codex, proven by the hash its result printed, kept on the UUID row; it opened #8.
const uuid = '01990000-0000-7000-8000-000000000001';
const rollout = `rollout-2026-03-02T11-00-00-${uuid}`;
session.run(rollout, 'codex', 'codex-jsonl', root, 'Ship two', at(11), at(11, 30));
runs(rollout, at(11), 'git commit -F msg.txt', 'call_commit', { row: uuid, id: 'call_commit:result' });
addCommit('bbb2222bbbb', at(11, 0, 10), 'fix: two');
runs(rollout, at(11, 5), 'gh pr create --fill', 'call_pr8', { row: uuid, id: 'call_pr8:result' });

// Only near a commit: a Claude session committed something else a minute later.
session.run('c2', 'claude', 'claude-jsonl', root, null, at(11, 50), at(12, 30));
addCommit('ccc3333cccc', at(12), 'chore: three', ['Claude Opus 5.5 <noreply@anthropic.com>']);
runs('c2', at(12, 1), 'git commit -F other.txt', 'toolu_c2');

// No session anywhere near.
addCommit('ddd4444dddd', at(15), 'docs: four');

const range = { date_from: '2026-03-02', date_to: '2026-03-02' };

test('commits count for an agent only on proof, the rest as outside, and coverage says why', () => {
  const activity = queries.getAnalyticsGitActivity(range);
  assert.deepEqual(activity.days, [{ date: '2026-03-02', by_agent: { claude: 1, codex: 1 }, outside: 2 }]);
  assert.deepEqual(activity.coverage, { commits: 4, proven: 2, time_only: 1, trailer_without_session: 1 });
  assert.deepEqual(activity.agents, [
    { agent: 'claude', commits: 1, sessions: 1, prs_opened: 1, prs_merged: 1 },
    { agent: 'codex', commits: 1, sessions: 1, prs_opened: 1, prs_merged: 0 },
  ]);
  assert.deepEqual(activity.projects, [{ project: 'alpha', commits: 4, by_agent: { claude: 1, codex: 1 }, outside: 2 }]);
  assert.deepEqual(activity.pull_requests.map(pr => [pr.number, pr.merged, pr.session_id, pr.agent]), [
    [8, false, rollout, 'codex'],
    [7, true, 'c1', 'claude'],
  ]);
});

test('the agent filter keeps that agent\'s proven commits and pull requests', () => {
  const activity = queries.getAnalyticsGitActivity({ ...range, agent: 'codex' });
  assert.deepEqual(activity.days[0], { date: '2026-03-02', by_agent: { codex: 1 }, outside: 0 });
  assert.deepEqual(activity.agents.map(row => row.agent), ['codex']);
});

test('a session shows the commits it proved and the pull requests it opened', () => {
  assert.deepEqual(queries.getSessionGitActivity('c1'), {
    commits: [{ sha: 'aaa1111aaaa', subject: 'feat: one', project: 'alpha', authored_at: at(10, 0, 30) }],
    pull_requests: [{ url: prUrl(7), repo: 'owner/alpha', number: 7, opened_at: at(10, 5), merged: true }],
  });
  assert.deepEqual(queries.getSessionGitActivity('c2'), { commits: [], pull_requests: [] }, 'being near a commit proves nothing');
});

test('a pull request whose URL arrived in a later poll of the running process counts for its session', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 3, hour, minute)).toISOString();
  const id = '01990000-0000-7000-8000-000000000002';
  const polled = `rollout-2026-03-03T09-00-00-${id}`;
  session.run(polled, 'codex', 'codex-jsonl', root, 'Open a PR', day(9), day(10));
  const toolCall = (when: string, toolName: string, input: string, callId: string, output: string) => {
    const messageId = Number(message.run(polled, ordinal++, when).lastInsertRowid);
    call.run(messageId, polled, toolName, callId, input);
    result.run(id, `${callId}:result`, JSON.stringify({ output }));
  };
  toolCall(day(9, 10), 'exec_command', JSON.stringify({ cmd: 'gh pr create --fill' }), 'call_open',
    'Chunk ID: aa\nProcess running with session ID 4242\nOutput:\n');
  // A poll of another process names an existing pull request: it opened nothing here.
  toolCall(day(9, 11), 'write_stdin', JSON.stringify({ session_id: 5151, chars: '' }), 'call_other', prUrl(3));
  toolCall(day(9, 12), 'write_stdin', JSON.stringify({ session_id: 4242, chars: '' }), 'call_poll', `Output:\n${prUrl(9)}\n`);

  assert.deepEqual(queries.getSessionGitActivity(polled).pull_requests.map(pr => pr.number), [9]);
  const activity = queries.getAnalyticsGitActivity({ date_from: '2026-03-03', date_to: '2026-03-03' });
  assert.deepEqual(activity.agents.map(row => [row.agent, row.prs_opened]), [['codex', 1]]);
});

test('GitHub\'s word marks a pull request merged that local git never saw merge', () => {
  assert.equal(queries.getSessionGitActivity(rollout).pull_requests[0].merged, false);
  const cache = db.prepare("INSERT INTO github_pull_requests (repo, number, state, merged_at, checked_at) VALUES ('owner/alpha', ?, ?, ?, ?)");
  cache.run(8, 'MERGED', at(21), at(22));
  // Local git's merge commit for #7 stands, whatever a stale answer says.
  cache.run(7, 'OPEN', null, at(9));
  assert.deepEqual(queries.getAnalyticsGitActivity(range).pull_requests.map(pr => [pr.number, pr.merged]), [[8, true], [7, true]]);
});

test('a commit run as `git -C <repo> commit` counts for its session', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 4, hour, minute)).toISOString();
  session.run('c-dash-c', 'claude', 'claude-jsonl', root, 'Commit from outside', day(9), day(10));
  runs('c-dash-c', day(9, 30), `git -C ${root} commit -m "feat: through -C"`, 'toolu_dash_c');
  addCommit('fff6666ffff', new Date(Date.UTC(2026, 2, 4, 9, 30, 20)).toISOString(), 'feat: through -C');
  assert.deepEqual(queries.getSessionGitActivity('c-dash-c').commits.map(row => row.sha), ['fff6666ffff']);
});

test('a pull request listed beside the one a call created is not one the session opened, on GitHub\'s word', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 5, hour, minute)).toISOString();
  session.run('c-list', 'claude', 'claude-jsonl', root, 'List and open', day(9), day(10));
  const messageId = Number(message.run('c-list', ordinal++, day(9, 30)).lastInsertRowid);
  call.run(messageId, 'c-list', 'Bash', 'toolu_list', JSON.stringify({ command: 'gh pr list --json url; gh pr create --fill' }));
  result.run('c-list', 'toolu_list', JSON.stringify({ content: `[{"url":"${prUrl(2)}"},{"url":"${prUrl(1)}"}]\n${prUrl(11)}` }));
  const cache = db.prepare("INSERT OR REPLACE INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at) VALUES ('owner/alpha', ?, 'OPEN', NULL, ?, ?)");
  cache.run(2, '2026-02-01T00:00:00Z', day(11));
  cache.run(11, new Date(Date.UTC(2026, 2, 5, 9, 31)).toISOString(), day(11));
  // #1 is not known to GitHub's cache yet, so its URL stands, as without GitHub.
  assert.deepEqual(queries.getSessionGitActivity('c-list').pull_requests.map(pr => pr.number), [1, 11]);
});

test('GitHub\'s answer about a pull request opened after the call is about another one that took the name, so it decides nothing', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 6, hour, minute)).toISOString();
  session.run('c-renamed', 'claude', 'claude-jsonl', root, 'Before the rename', day(9), day(10));
  runs('c-renamed', day(9, 30), 'gh pr create --fill', 'toolu_renamed');
  result.run('c-renamed', 'toolu_renamed', JSON.stringify({ content: prUrl(12) }));
  // The repository was renamed and its name reused; #12 there was opened weeks later and merged.
  db.prepare("INSERT OR REPLACE INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at) VALUES ('owner/alpha', 12, 'MERGED', ?, ?, ?)")
    .run('2026-04-01T00:00:00Z', '2026-03-28T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.deepEqual(queries.getSessionGitActivity('c-renamed').pull_requests.map(pr => [pr.number, pr.merged]), [[12, false]]);
});

test('a pull request opened from a yielded cell, with the repository flag, counts once its wait returns the URL', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 7, hour, minute)).toISOString();
  const id = '01990000-0000-7000-8000-000000000003';
  const cell = `rollout-2026-03-07T09-00-00-${id}`;
  session.run(cell, 'codex', 'codex-jsonl', root, 'Open from a cell', day(9), day(10));
  const toolCall = (when: string, toolName: string, input: string, callId: string, output: string) => {
    const messageId = Number(message.run(cell, ordinal++, when).lastInsertRowid);
    call.run(messageId, cell, toolName, callId, input);
    result.run(id, `${callId}:result`, JSON.stringify({ output }));
  };
  toolCall(day(9, 10), 'exec', JSON.stringify('text(await tools.exec_command({cmd:"gh -R owner/alpha pr create --fill"}))'), 'call_cell',
    'Script running with cell ID 67\nWall time 10.0 seconds\nOutput:\n');
  toolCall(day(9, 11), 'wait', JSON.stringify({ cell_id: '68', yield_time_ms: 1000 }), 'call_wait_other', prUrl(4));
  toolCall(day(9, 12), 'wait', JSON.stringify({ cell_id: '67', yield_time_ms: 1000 }), 'call_wait', `Script completed\nOutput:\n${prUrl(13)}\n`);
  assert.deepEqual(queries.getSessionGitActivity(cell).pull_requests.map(pr => pr.number), [13]);
});

test('an amend counts for the session that made it, though the author date predates the session', () => {
  const day = (hour: number, minute = 0) => new Date(Date.UTC(2026, 2, 8, hour, minute)).toISOString();
  session.run('c-amend', 'claude', 'claude-jsonl', root, 'Amend it', day(10), day(11));
  runs('c-amend', day(10, 30), 'git commit --amend --no-edit', 'toolu_amend', { row: 'c-amend', id: 'toolu_amend' });
  db.prepare("UPDATE session_items SET payload_json = ? WHERE session_id = 'c-amend' AND source_item_id = 'toolu_amend'")
    .run(JSON.stringify({ content: '[main 99aa111] feat: amended' }));
  db.prepare(`INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, author_name, author_email, subject, co_authors_json, is_merge)
    VALUES (?, '99aa1112222', ?, ?, 'Dev', 'dev@example.com', 'feat: amended', '[]', 0)`).run(root, day(8), new Date(Date.UTC(2026, 2, 8, 10, 30, 5)).toISOString());
  assert.deepEqual(queries.getSessionGitActivity('c-amend').commits.map(row => row.sha), ['99aa1112222']);
  // Authored late on the 8th, amended by a session on the 9th: still the 8th's commit, and that session's.
  session.run('c-amend-next', 'claude', 'claude-jsonl', root, 'Amend the next day', '2026-03-09T00:30:00.000Z', '2026-03-09T02:00:00.000Z');
  runs('c-amend-next', '2026-03-09T01:00:00.000Z', 'git commit --amend --no-edit', 'toolu_amend_next', { row: 'c-amend-next', id: 'toolu_amend_next' });
  db.prepare("UPDATE session_items SET payload_json = ? WHERE session_id = 'c-amend-next' AND source_item_id = 'toolu_amend_next'")
    .run(JSON.stringify({ content: '[main 77bb333] feat: amended next day' }));
  db.prepare(`INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, author_name, author_email, subject, co_authors_json, is_merge)
    VALUES (?, '77bb3334444', ?, ?, 'Dev', 'dev@example.com', 'feat: amended next day', '[]', 0)`).run(root, day(23), '2026-03-09T01:00:05.000Z');
  const activity = queries.getAnalyticsGitActivity({ date_from: '2026-03-08', date_to: '2026-03-08' });
  assert.deepEqual(activity.agents.map(row => [row.agent, row.commits, row.sessions]), [['claude', 2, 2]]);
});
