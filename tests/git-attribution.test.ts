import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeCommit,
  githubRepoOfRemote,
  mergedPullRequestNumber,
  pollsProcess,
  pullRequestUrls,
  runningProcessIds,
  type CommitCall,
} from '../src/git/attribution.js';

const at = (second: number) => Date.UTC(2026, 2, 2, 10, 0, 0) + second * 1000;
const commit = { sha: 'abc1234def5678', subject: 'fix(git): keep paths as git names them', at: at(0) };
const call = (session_id: string, agent: string, second: number, input = '{"command":"git commit -F msg.txt"}', result = ''): CommitCall =>
  ({ session_id, agent, at: at(second), input, result });
const none = () => [];

test('the hash in a result proves the session, over a rival that only ran close by', () => {
  const calls = [call('codex-1', 'codex', 3, '{}', '[main abc1234] fix(git): keep paths'), call('claude-1', 'claude', -10)];
  assert.deepEqual(attributeCommit(commit, calls, none), { kind: 'session', session_id: 'codex-1', agent: 'codex', evidence: 'hash' });
});

test('the subject in the command proves the session, however the input escapes it', () => {
  const inJson = JSON.stringify({ command: `git commit -m "${commit.subject}"` });
  assert.deepEqual(attributeCommit(commit, [call('claude-1', 'claude', 2, inJson), call('codex-1', 'codex', 5)], none),
    { kind: 'session', session_id: 'claude-1', agent: 'claude', evidence: 'subject' });
  // A subject with quotes is escaped once in JSON, and twice in Codex code mode
  // (a JS string inside the JSON input).
  const quoted = { ...commit, subject: 'docs: say "depth", not "trouble"' };
  const once = JSON.stringify({ command: `git commit -m '${quoted.subject}'` });
  assert.equal(attributeCommit(quoted, [call('claude-2', 'claude', 1, once)], none).kind, 'session');
  const twice = JSON.stringify(`text(await tools.exec_command({cmd: ${JSON.stringify(`git commit -m '${quoted.subject}'`)}}))`);
  assert.equal(attributeCommit(quoted, [call('codex-2', 'codex', 1, twice)], none).kind, 'session');
});

test('a message file written before the commit proves the session that wrote it', () => {
  const calls = [call('claude-1', 'claude', 1), call('claude-2', 'claude', 4)];
  const earlier = (sessionId: string) => sessionId === 'claude-2' ? [`cat > msg.txt <<'EOF'\n${commit.subject}\nEOF`] : ['ls'];
  assert.deepEqual(attributeCommit(commit, calls, earlier), { kind: 'session', session_id: 'claude-2', agent: 'claude', evidence: 'subject' });
});

test('timing alone proves nothing, and evidence for two sessions proves neither', () => {
  assert.deepEqual(attributeCommit(commit, [call('claude-1', 'claude', 30)], none), { kind: 'time_only' });
  const both = JSON.stringify({ command: `git commit -m "${commit.subject}"` });
  assert.deepEqual(attributeCommit(commit, [call('a', 'claude', 1, both), call('b', 'codex', 2, both)], none), { kind: 'time_only' });
});

test('no session committing within two minutes means the commit was made outside one', () => {
  assert.deepEqual(attributeCommit(commit, [call('claude-1', 'claude', 121)], none), { kind: 'outside' });
  assert.deepEqual(attributeCommit(commit, [], none), { kind: 'outside' });
});

test('pull requests come from their URLs, merges from their commits, repositories from their remotes', () => {
  assert.deepEqual(pullRequestUrls('Creating pull request\nhttps://github.com/Owner/Repo/pull/12\nhttps://github.com/Owner/Repo/pull/12'),
    [{ repo: 'owner/repo', number: 12, url: 'https://github.com/Owner/Repo/pull/12' }]);
  assert.deepEqual(pullRequestUrls('https://github.com/owner/repo/pull/9#issuecomment-123\nhttps://github.com/owner/repo/pull/10'),
    [{ repo: 'owner/repo', number: 10, url: 'https://github.com/owner/repo/pull/10' }], 'a link into an existing pull request opened nothing');
  assert.equal(mergedPullRequestNumber('Merge pull request #249 from owner/feat/git', true), 249);
  assert.equal(mergedPullRequestNumber('feat: squashed change (#17)', false), 17);
  assert.equal(mergedPullRequestNumber('Merge branch main into feature', true), null);
  assert.equal(mergedPullRequestNumber('Merge branch main into feature (#5)', true), null, 'a merge merges only by GitHub\'s own subject');
  assert.equal(mergedPullRequestNumber('Merge pull request #3 from owner/x', false), null, 'only a merge commit merges');
  assert.equal(githubRepoOfRemote('git@github.com:Owner/Repo.git'), 'owner/repo');
  assert.equal(githubRepoOfRemote('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(githubRepoOfRemote('https://gitlab.com/owner/repo.git'), null);
});

test('a Codex call left running names its processes, and a poll of one carries the rest of its output', () => {
  const native = JSON.stringify({ output: 'Chunk ID: e82876\nWall time: 1.0020 seconds\nProcess running with session ID 23171\nOutput:\n' });
  assert.deepEqual(runningProcessIds(native), ['23171']);
  const chunks = '{"chunk_id":"451d0f","exit_code":0,"output":""}{"chunk_id":"3b73f0","session_id":62286,"output":""}';
  const codeMode = JSON.stringify({ content: `Script completed\nOutput:\n${chunks}` });
  assert.deepEqual(runningProcessIds(codeMode), ['62286'], 'a finished chunk has an exit code, not a process');
  assert.deepEqual(runningProcessIds(JSON.stringify({ content: '[main abc1234] fix: done' })), []);

  assert.ok(pollsProcess('write_stdin', '{"session_id":23171,"chars":""}', '23171'));
  assert.ok(pollsProcess('exec', JSON.stringify('text(await tools.write_stdin({session_id:62286,chars:""}));'), '62286'));
  assert.ok(pollsProcess('exec', JSON.stringify('for (const id of [63370,36264])text(await tools.write_stdin({session_id:id}));'), '36264'));
  assert.ok(!pollsProcess('write_stdin', '{"session_id":231710,"chars":""}', '23171'), 'another process whose id contains this one');
  assert.ok(!pollsProcess('exec', JSON.stringify('text(await tools.exec_command({cmd:"sleep 23171"}));'), '23171'), 'not a poll');
});
