import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-outcomes-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';
process.env.AGENTMONITOR_GITHUB_LOOKUPS = '1';
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

const at = (day: number, hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 4, day, hour, minute, second)).toISOString();
const alpha = path.join(tempDir, 'alpha');
const beta = path.join(tempDir, 'beta');
const repo = db.prepare('INSERT INTO git_repos (root, last_scanned_at, github_repo) VALUES (?, ?, ?)');
repo.run(alpha, at(20, 0), 'owner/alpha');
repo.run(beta, at(20, 0), 'owner/beta');

const commitRow = db.prepare(`INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, author_name, author_email, subject, landing)
  VALUES (?, ?, ?, ?, 'Dev', 'dev@example.com', ?, ?)`);
const session = db.prepare(`INSERT INTO browsing_sessions (id, agent, integration_mode, cwd, title, started_at, ended_at, message_count, user_message_count, parent_session_id, relationship_type)
  VALUES (?, ?, ?, ?, 'work', ?, ?, 10, 1, ?, ?)`);
let ordinal = 0;
const message = db.prepare("INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, 'assistant', '[]', ?)");
const call = db.prepare('INSERT INTO tool_calls (message_id, session_id, tool_name, tool_use_id, input_json) VALUES (?, ?, ?, ?, ?)');
const result = db.prepare("INSERT INTO session_items (session_id, ordinal, source_item_id, kind, status, payload_json) VALUES (?, 0, ?, 'tool_result', 'success', ?)");
const usage = db.prepare(`INSERT INTO events (session_id, agent_type, event_type, model, project, tokens_in, tokens_out, cost_usd, client_timestamp, source)
  VALUES (?, ?, 'llm_response', 'claude-opus-5-5', ?, ?, ?, ?, ?, 'import')`);
const spend = (sessionId: string, agent: 'claude_code' | 'codex', project: string, usd: number, when: string) =>
  usage.run(sessionId, agent, project, usd * 1000, 0, usd, when);

/** A session's `git commit -m`, and the commit it made 30 s later, which proves it. */
function commits(sessionId: string, root: string, sha: string, when: string, subject: string, landing: string | null) {
  const messageId = Number(message.run(sessionId, ordinal++, when).lastInsertRowid);
  call.run(messageId, sessionId, 'Bash', `toolu_${sha}`, JSON.stringify({ command: `git commit -m "${subject}"` }));
  const made = new Date(Date.parse(when) + 30_000).toISOString();
  commitRow.run(root, sha, made, made, subject, landing);
}
const pr = db.prepare(`INSERT INTO github_pull_requests (repo, number, state, merged_at, created_at, checked_at, additions, deletions, changed_files, commit_count, author_is_bot, details_at)
  VALUES (?, ?, 'MERGED', ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
const member = db.prepare('INSERT INTO github_pull_request_commits (repo, number, sha, source) VALUES (?, ?, ?, ?)');

// A Claude session in alpha: two pull requests, a push, a branch never merged, then talk.
session.run('c1', 'claude', 'claude-jsonl', alpha, at(11, 22), at(13, 23), null, null);
spend('c1', 'claude_code', 'alpha', 5, at(11, 23)); // the day before the range, toward #1
spend('c1', 'claude_code', 'alpha', 1, at(12, 9));
spend('c1', 'claude_code', 'alpha', 2, at(12, 9, 10));
commits('c1', alpha, 'aaaa000001', at(12, 9, 15), 'feat: one', 'merged');
spend('c1', 'claude_code', 'alpha', 4, at(12, 9, 20));
commits('c1', alpha, 'aaaa000002', at(12, 9, 25), 'feat: two', 'merged');
spend('c1', 'claude_code', 'alpha', 1, at(12, 9, 30));
commits('c1', alpha, 'aaaa000003', at(12, 9, 35), 'chore: pushed', 'direct');
spend('c1', 'claude_code', 'alpha', 2, at(12, 9, 40));
commits('c1', alpha, 'aaaa000004', at(12, 9, 45), 'wip: never merged', null);
spend('c1', 'claude_code', 'alpha', 0.5, at(12, 9, 50));

// Another session's last minute in the range, toward a push the day after it.
session.run('c4', 'claude', 'claude-jsonl', alpha, at(13, 23), at(14, 1), null, null);
spend('c4', 'claude_code', 'alpha', 1, at(13, 23, 50));
commits('c4', alpha, 'aaaa000005', at(14, 0, 10), 'chore: next day', 'direct');

// A Codex session (rollout row and import row under one key) whose subagent did the work for #3.
const codexId = '01990000-0000-7000-8000-00000000c0de';
const rollout = `rollout-2026-05-12T10-00-00-${codexId}`;
const childId = '01990000-0000-7000-8000-0000000c41d0';
session.run(rollout, 'codex', 'codex-jsonl', alpha, at(12, 10), at(12, 12), null, null);
session.run(codexId, 'codex', 'codex-import', alpha, at(12, 10), at(12, 12), null, null);
session.run(childId, 'codex', 'codex-import', alpha, at(12, 10, 30), at(12, 11, 30), rollout, 'subagent');
spend(childId, 'codex', 'alpha', 3, at(12, 11));
spend(codexId, 'codex', 'alpha', 1, at(12, 11, 5));
{
  const when = at(12, 11, 10);
  const messageId = Number(message.run(rollout, ordinal++, when).lastInsertRowid);
  call.run(messageId, rollout, 'exec_command', 'call_commit', JSON.stringify({ cmd: 'git commit -F msg.txt' }));
  result.run(codexId, 'call_commit:result', JSON.stringify({ output: '[feat/three cccc000003] feat: three' }));
  const made = at(12, 11, 10, 20);
  commitRow.run(alpha, 'cccc0000030000', made, made, 'feat: three', 'merged');
}

/** A session's `gh pr create`, which printed the pull request's URL. */
function opens(sessionId: string, when: string, url: string) {
  const messageId = Number(message.run(sessionId, ordinal++, when).lastInsertRowid);
  call.run(messageId, sessionId, 'Bash', `toolu_open_${ordinal}`, JSON.stringify({ command: 'gh pr create --fill' }));
  result.run(sessionId, `toolu_open_${ordinal}`, JSON.stringify({ content: url }));
}

// A Claude session in beta: a commit, then the pull request it opened, merged as #4 with a list from a local merge.
session.run('c3', 'claude', 'claude-jsonl', beta, at(12, 14), at(12, 15), null, null);
spend('c3', 'claude_code', 'beta', 2, at(12, 14));
commits('c3', beta, 'bbbb000001', at(12, 14, 5), 'feat: four', 'merged');
spend('c3', 'claude_code', 'beta', 0.5, at(12, 14, 6));
opens('c3', at(12, 14, 7), 'https://github.com/owner/beta/pull/4');

// A session that opened #7, which GitHub says merged, but as a pull request
// created after the call: the name was reused, so this one did not land.
session.run('c6', 'claude', 'claude-jsonl', alpha, at(12, 18), at(12, 19), null, null);
spend('c6', 'claude_code', 'alpha', 1, at(12, 18));
opens('c6', at(12, 18, 5), 'https://github.com/owner/alpha/pull/7');

// Spend no milestone could be seen for: no transcript, and a session with no tool calls.
spend('ghost', 'claude_code', 'alpha', 2, at(12, 12));
session.run('quiet', 'claude', 'claude-jsonl', alpha, at(12, 16), at(12, 17), null, null);
spend('quiet', 'claude_code', 'alpha', 1, at(12, 16, 30));

const checked = at(20, 0);
pr.run('owner/alpha', 1, at(12, 13), at(12, 9, 16), checked, 100, 50, 1, 0, checked);
pr.run('owner/alpha', 2, at(13, 10), at(12, 9, 26), checked, 400, 200, 2, 0, checked); // two commits, one listed
pr.run('owner/alpha', 3, at(12, 15), at(12, 11, 11), checked, 1000, 200, 1, 0, checked);
pr.run('owner/beta', 4, at(12, 16), at(12, 14, 6), checked, null, null, null, null, null);
pr.run('owner/alpha', 5, at(13, 12), at(13, 11), checked, 10, 0, 1, 0, checked); // from another machine
pr.run('owner/alpha', 6, at(13, 12), at(13, 11), checked, 10, 0, 1, 1, checked); // a bot's
pr.run('owner/alpha', 7, at(12, 20), at(13, 9), checked, 10, 0, 1, 0, checked); // the reused name
member.run('owner/alpha', 1, 'aaaa000001', 'github');
member.run('owner/alpha', 2, 'aaaa000002', 'github');
member.run('owner/alpha', 3, 'cccc0000030000', 'github');
member.run('owner/beta', 4, 'bbbb000001', 'local');

const range = { date_from: '2026-05-12', date_to: '2026-05-13' };
const spendOf = (outcomes: { spend: Array<{ outcome: string; usd: number }> }) =>
  Object.fromEntries(outcomes.spend.filter(row => row.usd > 0).map(row => [row.outcome, row.usd]));

test("the range's spend goes to what each session's timeline led to, counting each dollar once", () => {
  const outcomes = queries.getAnalyticsOutcomes(range);
  assert.equal(outcomes.total_usd, 22);
  assert.deepEqual(spendOf(outcomes), {
    merged_pr: 13.5, // #1 3, #2 4, #3 4 (the subagent's 3 with its parent), #4 2.5 (its commit, then opening it)
    direct: 2, // the push, and the range's last minute toward the next day's
    not_landed: 3, // the branch never merged, and #7
    nothing_after: 0.5,
    unobservable: 3,
  });
  assert.deepEqual(outcomes.spend.map(row => row.outcome), ['merged_pr', 'direct', 'other_landed', 'not_landed', 'nothing_after', 'unobservable'],
    'every class, in order, empty ones too');
  assert.ok(Math.abs(outcomes.spend.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  const usageTotal = queries.getUsageRows(range).reduce((sum, row) => sum + row.cost_usd, 0);
  assert.equal(outcomes.total_usd, Math.round(usageTotal * 1e6) / 1e6, "the range's dollars are Usage's");
});

test('a merged pull request costs the spend allocated to it, work before the range included', () => {
  const outcomes = queries.getAnalyticsOutcomes(range);
  // #1 8 (5 the day before), #2 4, #3 4, #4 2.5.
  assert.deepEqual(outcomes.merged_prs, { prs: 4, median_usd: 4, p25_usd: 3.625, p75_usd: 5, p90_usd: 6.8, all_in_usd: 5.5 });
  assert.deepEqual(outcomes.weeks, [{ week: '2026-05-11', prs: 4, median_usd: 4, p25_usd: 3.625, p75_usd: 5, p90_usd: 6.8, median_tokens: 4000, usd_per_mtok: 1000 }]);
  assert.deepEqual(outcomes.sizes, [
    { bucket: '<200', prs: 1, median_usd: 8 },
    { bucket: '200-499', prs: 0, median_usd: null },
    { bucket: '500-999', prs: 1, median_usd: 4 },
    { bucket: '1000+', prs: 1, median_usd: 4 },
  ]);
  assert.equal(outcomes.unknown_size, 1);
  assert.deepEqual(outcomes.projects.map(row => [row.project, row.prs, row.median_usd]), [['alpha', 3, 4], ['beta', 1, 2.5]]);
});

test('coverage says how much spend could be followed and how many of GitHub\'s merged pull requests it reached', () => {
  const { coverage } = queries.getAnalyticsOutcomes(range);
  assert.ok(Math.abs((coverage.observable_share ?? 0) - 19 / 22) < 1e-9);
  assert.deepEqual({ ...coverage, observable_share: null }, {
    observable_share: null,
    lookups: true,
    github_merged: 6, // #1-#5 and #7; the bot's left out
    github_linked: 4,
    truncated_commit_lists: 1,
    membership: { github: 3, local: 1, none: 0 },
  });
});

test('the agent and project filters narrow spend and pull requests together', () => {
  const codex = queries.getAnalyticsOutcomes({ ...range, agent: 'codex' });
  assert.equal(codex.total_usd, 4);
  assert.deepEqual(spendOf(codex), { merged_pr: 4 });
  assert.equal(codex.merged_prs.prs, 1);
  assert.equal(codex.coverage.github_merged, null, 'GitHub cannot say which agent merged what');

  const betaOnly = queries.getAnalyticsOutcomes({ ...range, project: 'beta' });
  assert.equal(betaOnly.total_usd, 2.5);
  assert.deepEqual(betaOnly.projects.map(row => row.project), ['beta']);
  assert.equal(betaOnly.merged_prs.prs, 1);
});
