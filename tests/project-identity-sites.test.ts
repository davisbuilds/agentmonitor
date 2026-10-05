import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Every path that turns a working directory into a project name uses the
// canonical identity: a worktree reports its repository, not its folder.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-project-sites-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, 'Dev', 'app');
fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'app-task'), { recursive: true });
fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'app-task', 'commondir'), '../..\n');
const cwd = path.join(root, 'Dev', '.worktrees', 'app-task');
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'app-task')}\n`);

process.env.AGENTMONITOR_DB_PATH = path.join(root, 'unused.db');
const { parseSessionMessages } = await import('../src/parser/claude-code.js');
const { parseCodexSessionMessages } = await import('../src/parser/codex-sessions.js');
const { parseClaudeCodeFile } = await import('../src/import/claude-code.js');
const { parseCodexFile } = await import('../src/import/codex.js');
const { normalizeIngestEvent } = await import('../src/contracts/event-contract.js');

const claudeLines = [
  { type: 'user', uuid: 'u1', sessionId: 'c-1', cwd, timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'a1', sessionId: 'c-1', cwd, timestamp: '2026-10-05T10:00:01Z', message: {
    role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 10, output_tokens: 5 }, id: 'msg_1',
  } },
];
const claudeFile = path.join(root, '-encoded-elsewhere', 'c-1.jsonl');
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, claudeLines.map(line => JSON.stringify(line)).join('\n'));

const codexLines = [
  { type: 'session_meta', timestamp: '2026-10-05T10:00:00Z', payload: { id: '01a0a5aa-cc7f-7b91-a14c-ffda7ce66b47', cwd, source: 'cli', timestamp: '2026-10-05T10:00:00Z' } },
  { type: 'response_item', timestamp: '2026-10-05T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
  { type: 'event_msg', timestamp: '2026-10-05T10:00:02Z', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 },
    last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 },
  } } },
];
const codexFile = path.join(root, 'rollout-2026-10-05T10-00-00-01a0a5aa-cc7f-7b91-a14c-ffda7ce66b47.jsonl');
fs.writeFileSync(codexFile, codexLines.map(line => JSON.stringify(line)).join('\n'));

test('the Claude session browser names the project from the transcript cwd', () => {
  const parsed = parseSessionMessages(fs.readFileSync(claudeFile, 'utf8'), 'c-1', claudeFile);
  assert.equal(parsed.metadata.project, 'app');
});

test('the Codex session browser names the repository', () => {
  assert.equal(parseCodexSessionMessages(fs.readFileSync(codexFile, 'utf8'), 'codex-1', codexFile).metadata.project, 'app');
});

test('imported Claude and Codex events name the repository', () => {
  const claude = parseClaudeCodeFile(claudeFile);
  assert.ok(claude.length > 0);
  assert.deepEqual([...new Set(claude.map(event => event.project))], ['app']);
  const codex = parseCodexFile(codexFile);
  assert.ok(codex.length > 0);
  assert.deepEqual([...new Set(codex.map(event => event.project))], ['app']);
});

test('an ingested event with a cwd is named from it', () => {
  const base = { session_id: 's', agent_type: 'claude_code', event_type: 'tool_use', project: 'app-task' };
  const withCwd = normalizeIngestEvent({ ...base, cwd });
  assert.ok(withCwd.ok);
  assert.equal(withCwd.event.project, 'app');
  assert.ok(!('cwd' in withCwd.event), 'the cwd is not stored');
  const without = normalizeIngestEvent(base);
  assert.ok(without.ok);
  assert.equal(without.event.project, 'app-task', 'without a cwd the given project stands');
});
