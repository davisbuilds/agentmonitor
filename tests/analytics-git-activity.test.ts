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
