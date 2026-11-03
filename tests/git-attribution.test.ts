import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeCommit,
  createdCommit,
  createdPullRequestUrls,
  isPullRequestTool,
  githubRepoOfRemote,
  mergedPullRequestNumber,
  opensPullRequest,
  pollsProcess,
  pullRequestUrls,
  runningProcessIds,
  runsGitCommit,
  waitsOnCell,
  yieldedCellIds,
  type CommitCall,
} from '../src/git/attribution.js';

const at = (second: number) => Date.UTC(2026, 2, 2, 10, 0, 0) + second * 1000;
const commit = { sha: 'abc1234def5678', subject: 'fix(git): keep paths as git names them', at: at(0), committed_at: at(0), repo_root: '/w/alpha', project: 'alpha' };
const call = (session_id: string, agent: string, second: number, input = '{"command":"git commit -F msg.txt"}', result = '', project: string | null = 'alpha'): CommitCall =>
  ({ session_id, agent, at: at(second), input, result, cwd: project ? `/w/${project}` : null, project });
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

test('a subject proves a session only for a commit in the repository it worked in', () => {
  const subject = JSON.stringify({ command: `git commit -m "${commit.subject}"` });
  // The same subject committed in another repository a moment later.
  assert.deepEqual(attributeCommit(commit, [call('beta-1', 'claude', 1, subject, '', 'beta')], none), { kind: 'time_only' });
  // A session in a folder of projects proves it when its command reaches the repository.
  const reaches = JSON.stringify({ command: `cd /w/alpha && git commit -m "${commit.subject}"` });
  assert.deepEqual(attributeCommit(commit, [call('dev-1', 'codex', 1, reaches, '', 'Dev')], none),
    { kind: 'session', session_id: 'dev-1', agent: 'codex', evidence: 'subject' });
  // So does an earlier call that wrote the message there.
  const earlier = () => [`cd /w/alpha && printf '${commit.subject}' > msg.txt`];
  assert.equal(attributeCommit(commit, [call('dev-2', 'codex', 1, '{"command":"git commit -F msg.txt"}', '', 'Dev')], earlier).kind, 'session');
  const elsewhere = () => [`printf '${commit.subject}' > msg.txt`];
  assert.deepEqual(attributeCommit(commit, [call('beta-3', 'claude', 1, '{"command":"git commit -F msg.txt"}', '', 'beta')], elsewhere),
    { kind: 'time_only' }, 'a message written in another repository');
  // The shell keeps the directory an earlier call moved it to, however long ago.
  const movedEarlier = (_sessionId: string, from: number) => from < commit.at - 15 * 60_000
    ? ['cd /w/alpha', JSON.stringify({ command: `git commit -m "${commit.subject}"` })]
    : [JSON.stringify({ command: `git commit -m "${commit.subject}"` })];
  assert.equal(attributeCommit(commit, [call('dev-3', 'claude', 1, JSON.stringify({ command: `git commit -m "${commit.subject}"` }), '', 'Dev')], movedEarlier).kind,
    'session', 'a session that moved into the repository before');
  // A hash names one commit wherever it ran.
  assert.equal(attributeCommit(commit, [call('beta-2', 'codex', 1, '{}', '[main abc1234] fix', 'beta')], none).kind, 'session');
});

test('the strongest evidence pointing at two sessions proves neither, whatever weaker evidence says', () => {
  const subject = JSON.stringify({ command: `git commit -m "${commit.subject}"` });
  const hash = '[main abc1234] fix';
  assert.deepEqual(attributeCommit(commit, [call('a', 'codex', 1, subject, hash), call('b', 'codex', 2, '{}', hash)], none), { kind: 'time_only' });
  const wrote = (sessionId: string) => sessionId === 'c' ? [`echo '${commit.subject}' > msg.txt`] : [];
  assert.deepEqual(attributeCommit(commit, [call('a', 'claude', 1, subject), call('b', 'claude', 2, subject), call('c', 'claude', 3)], wrote),
    { kind: 'time_only' });
});

test('only git\'s line for the commit it created proves a hash, not one a log printed', () => {
  const sha = 'abc1234def5678';
  assert.ok(createdCommit('[main abc1234] fix: done', sha));
  assert.ok(createdCommit('[main (root-commit) abc1234] first', sha));
  assert.ok(createdCommit('[detached HEAD abc1234] fix', sha));
  assert.ok(createdCommit(JSON.stringify({ output: '[feat/git-view abc1234] fix: done\n 2 files changed' }), sha));
  assert.ok(!createdCommit('abc1234 human change\n[main def5678] agent change', sha), 'a log line before the commit');
  assert.ok(!createdCommit('[main abc12345] other', sha), 'another commit sharing the prefix');
  const logged = call('codex-1', 'codex', 3, '{"command":"git log -1 --oneline; git commit -m \\"agent change\\""}', 'abc1234 human change\n[main def5678] agent change');
  assert.deepEqual(attributeCommit(commit, [logged], none), { kind: 'time_only' });
});

test('a commit is a commit with git\'s global options before it', () => {
  assert.ok(runsGitCommit(JSON.stringify({ command: 'cd /w/alpha\ngit add -A\ngit commit -m x' })), 'a line of a stored script');
  assert.ok(runsGitCommit(JSON.stringify({ command: 'make\tgit commit -m x' })));
  for (const command of ['git commit -m x', 'git -C /w/alpha commit -m x', 'git -c user.name=Dev commit -F msg', 'git --no-pager -C "$repo" commit -q']) {
    assert.ok(runsGitCommit(JSON.stringify({ command })), command);
  }
  for (const command of ['git log --grep commit', 'git commit-tree HEAD^{tree}', 'git show --stat', 'echo "git -C x status"; commit=1']) {
    assert.ok(!runsGitCommit(JSON.stringify({ command })), command);
  }
});

test('a yielded code-mode cell names its id, and a wait on it carries the rest of its output', () => {
  const yielded = JSON.stringify({ tool_name: 'exec', output: 'Script running with cell ID 67\nWall time 10.0 seconds\nOutput:\n' });
  assert.deepEqual(yieldedCellIds(yielded), ['67']);
  assert.deepEqual(yieldedCellIds(JSON.stringify({ output: 'Script completed\nOutput:\n' })), []);
  assert.ok(waitsOnCell('wait', '{"cell_id":"67","yield_time_ms":1000}', '67'));
  assert.ok(!waitsOnCell('wait', '{"cell_id":"670","yield_time_ms":1000}', '67'), 'another cell');
  assert.ok(!waitsOnCell('exec', 'text(await tools.exec_command({cmd:"echo 67"}))', '67'), 'not a wait');
});

test('a pull request is opened by gh pr create, with the repository flag anywhere gh takes it', () => {
  for (const command of ['gh pr create --fill', 'gh -R owner/repo pr create --fill', 'gh pr --repo owner/repo create', 'gh pr -R=owner/repo create -t x', 'cd x\ngh pr create']) {
    assert.ok(opensPullRequest(JSON.stringify({ command })), command);
  }
  for (const command of ['gh pr view 12', 'gh -R owner/repo pr list', 'echo "gh pr" && create-thing', 'gh pr create-draft']) {
    assert.ok(!opensPullRequest(JSON.stringify({ command })), command);
  }
});

test('a commit is matched to the call that created it, an amend moving only its committer date', () => {
  // Amended ten minutes after it was first authored: the author date stays.
  const amended = { ...commit, committed_at: at(600) };
  const amend = call('claude-1', 'claude', 601, '{"command":"git commit --amend --no-edit"}', '[main abc1234] fix(git): keep paths');
  assert.deepEqual(attributeCommit(amended, [amend], none), { kind: 'session', session_id: 'claude-1', agent: 'claude', evidence: 'hash' });
  // Rebased an hour later: the original commit call, by the author date, still proves it by subject.
  const rebased = { ...commit, committed_at: at(3600) };
  const original = call('claude-2', 'claude', 1, JSON.stringify({ command: `git commit -m "${commit.subject}"` }));
  assert.deepEqual(attributeCommit(rebased, [original], none), { kind: 'session', session_id: 'claude-2', agent: 'claude', evidence: 'subject' });
});

test('a subject proves a commit only whole, not by a shared opening', () => {
  const backend = { ...commit, subject: 'chore(deps): update production dependencies for the backend' };
  const frontend = JSON.stringify({ command: 'git commit -m "chore(deps): update production dependencies for the frontend"' });
  assert.deepEqual(attributeCommit(backend, [call('a', 'claude', 1, frontend)], none), { kind: 'time_only' });
  const short = { ...commit, subject: 'fix: paths' };
  assert.equal(attributeCommit(short, [call('b', 'claude', 1, JSON.stringify({ command: 'git commit -m "fix: paths and names"' }))], none).kind, 'time_only',
    'the opening of a longer subject');
  const heredoc = JSON.stringify({ command: "git commit -F - <<'EOF'\nfix: paths\n\nBody.\nEOF" });
  assert.equal(attributeCommit(short, [call('c', 'claude', 1, heredoc)], none).kind, 'session', 'a subject line in a message');
  // Shell quoting inside the subject, as stored: escaped double quotes, and a single quote closed and reopened.
  const quoted = { ...commit, subject: 'docs: describe Quality\'s "missing" state' };
  const shell = JSON.stringify({ command: `git commit -m 'docs: describe Quality'"'"'s \\"missing\\" state'` });
  assert.equal(attributeCommit(quoted, [call('d', 'claude', 1, shell)], none).kind, 'session', 'shell quoting');
});

test('a poll follows a process only by its session_id argument', () => {
  assert.ok(!pollsProcess('write_stdin', '{"session_id":5151,"chars":"","yield_time_ms":1000}', '1000'), 'an option value');
  assert.ok(!pollsProcess('exec', JSON.stringify('text(await tools.write_stdin({session_id:5151,chars:"1000"}));'), '1000'), 'stdin text');
  assert.ok(pollsProcess('exec', JSON.stringify('text(await tools.write_stdin({"session_id":1000,chars:""}));'), '1000'));
});

test('a GitHub tool that creates a pull request is known by its name, and its result by its url field', () => {
  for (const name of ['_create_pull_request', 'mcp__github__create_pull_request', 'mcp__codex_apps__github_create_pull_request']) assert.ok(isPullRequestTool(name), name);
  for (const name of ['mcp__github__create_pull_request_review', '_update_pull_request', 'mcp__github__list_pull_requests', 'Bash']) assert.ok(!isPullRequestTool(name), name);
  const stored = JSON.stringify({ content: `Output:\n${JSON.stringify({ html_url: 'https://github.com/Owner/Repo/pull/9', body: 'after https://github.com/owner/repo/pull/3' })}` });
  assert.deepEqual(createdPullRequestUrls(stored), [{ repo: 'owner/repo', number: 9, url: 'https://github.com/Owner/Repo/pull/9' }]);
  assert.deepEqual(createdPullRequestUrls(JSON.stringify({ content: 'Error: validation failed' })), []);
  // A body quoting JSON with its own url field, ahead of the result's.
  const quoting = { body: 'Related: {"url":"https://github.com/owner/repo/pull/3"}', url: 'https://github.com/owner/repo/pull/15' };
  assert.deepEqual(createdPullRequestUrls(JSON.stringify({ content: `Wall time: 1.5 seconds\nOutput:\n${JSON.stringify(quoting)}` })).map(ref => ref.number), [15]);
  // Cut off mid-body, as a stored result keeps only its first part.
  const cut = `Output:\n${JSON.stringify({ url: 'https://github.com/owner/repo/pull/17', number: 17, body: 'x'.repeat(50) + ' see https://github.com/owner/repo/pull/3' })}`.slice(0, 120);
  assert.deepEqual(createdPullRequestUrls(JSON.stringify({ content: cut })).map(ref => ref.number), [17]);
  // A nested object's own html_url, ahead of the result's.
  const nested = { base: { html_url: 'https://github.com/owner/repo/pull/3' }, html_url: 'https://github.com/owner/repo/pull/18' };
  assert.deepEqual(createdPullRequestUrls(JSON.stringify({ content: `Output:\n${JSON.stringify(nested)}` })).map(ref => ref.number), [18]);
  // An MCP result: content blocks of text.
  const blocks = { content: [{ type: 'text', text: JSON.stringify({ number: 16, html_url: 'https://github.com/owner/repo/pull/16' }) }] };
  assert.deepEqual(createdPullRequestUrls(JSON.stringify(blocks)).map(ref => ref.number), [16]);
});
