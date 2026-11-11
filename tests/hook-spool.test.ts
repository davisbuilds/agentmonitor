import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-hook-spool-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { normalizeIngestEvent } = await import('../src/contracts/event-contract.js');
const { drainHookSpool } = await import('../src/import/hook-spool.js');

initSchema();
after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const spool = path.join(tempDir, 'spool');
beforeEach(() => {
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  db.exec('DELETE FROM events; DELETE FROM sessions');
  fs.rmSync(spool, { recursive: true, force: true });
  fs.mkdirSync(spool, { mode: 0o700 });
});

function spooled(name: string, body: string): string {
  const file = path.join(spool, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

const event = (id: string, at: string) => JSON.stringify({
  event_id: id, client_timestamp: at, session_id: 'spooled-session', agent_type: 'claude_code',
  event_type: 'tool_use', tool_name: 'Bash', source: 'hook', metadata: {},
});
const stored = () => getDb().prepare('SELECT event_id, client_timestamp, tool_name FROM events ORDER BY id').all();

test('spooled events are stored oldest first, with their own time, and their files removed', () => {
  spooled('1762840000-b.json', event('b', '2026-11-11T05:46:40Z'));
  spooled('1762839000-a.json', event('a', '2026-11-11T05:30:00Z'));

  assert.deepEqual(drainHookSpool(spool), { ingested: 2, duplicates: 0, rejected: 0, errors: 0 });
  assert.deepEqual(stored(), [
    { event_id: 'a', client_timestamp: '2026-11-11T05:30:00.000Z', tool_name: 'Bash' },
    { event_id: 'b', client_timestamp: '2026-11-11T05:46:40.000Z', tool_name: 'Bash' },
  ]);
  assert.deepEqual(fs.readdirSync(spool), []);
});

test('an event the server already has is dropped, not stored twice', () => {
  // The server answered after the hook gave up waiting, and the hook spooled it too.
  const parsed = normalizeIngestEvent(JSON.parse(event('late', '2026-11-11T05:30:00Z')));
  assert.ok(parsed.ok);
  insertEvent(parsed.event);
  spooled('1762839000-late.json', event('late', '2026-11-11T05:30:00Z'));

  assert.deepEqual(drainHookSpool(spool), { ingested: 0, duplicates: 1, rejected: 0, errors: 0 });
  assert.equal(stored().length, 1);
  assert.deepEqual(fs.readdirSync(spool), []);
});

test('a file that is not a valid event is set aside, not retried forever', () => {
  spooled('1762839000-torn.json', '{"event_id": "torn", "session_');
  spooled('1762839001-invalid.json', JSON.stringify({ event_id: 'invalid', event_type: 'tool_use' }));

  assert.deepEqual(drainHookSpool(spool), { ingested: 0, duplicates: 0, rejected: 2, errors: 0 });
  assert.deepEqual(fs.readdirSync(path.join(spool, 'rejected')).sort(), ['1762839000-torn.json', '1762839001-invalid.json']);
  assert.deepEqual(fs.readdirSync(spool), ['rejected']);
});

test('an unsafe spool is not read: others can write it, or it is a link', () => {
  spooled('1762839000-a.json', event('a', '2026-11-11T05:30:00Z'));
  fs.chmodSync(spool, 0o777);
  assert.deepEqual(drainHookSpool(spool), { ingested: 0, duplicates: 0, rejected: 0, errors: 1 });
  fs.chmodSync(spool, 0o700);

  const link = path.join(tempDir, 'spool-link');
  fs.symlinkSync(spool, link);
  assert.deepEqual(drainHookSpool(link), { ingested: 0, duplicates: 0, rejected: 0, errors: 1 });
  fs.rmSync(link);
  assert.equal(stored().length, 0);

  // Files only partly written (a dot-prefixed temporary name) wait for their rename.
  spooled('.1762839000-b.tmp', event('b', '2026-11-11T05:30:00Z'));
  assert.deepEqual(drainHookSpool(spool), { ingested: 1, duplicates: 0, rejected: 0, errors: 0 });
  assert.ok(fs.existsSync(path.join(spool, '.1762839000-b.tmp')));
});

test('a missing spool is no error: nothing was spooled', () => {
  assert.deepEqual(drainHookSpool(path.join(tempDir, 'never-created')), { ingested: 0, duplicates: 0, rejected: 0, errors: 0 });
});

test('an event a real hook spooled while the server was down is stored by the next drain', async () => {
  const { execFileSync } = await import('node:child_process');
  const hook = path.resolve(import.meta.dirname, '..', 'hooks', 'claude-code', 'post_tool_use.sh');
  execFileSync('bash', [hook], {
    input: JSON.stringify({
      session_id: 'spool-e2e', cwd: tempDir, hook_event_name: 'PostToolUse',
      tool_name: 'Grep', tool_input: { pattern: 'needle' }, tool_response: { success: true },
    }),
    // A port nothing listens on: the server is down.
    env: { ...process.env, AGENTMONITOR_URL: 'http://127.0.0.1:9', AGENTMONITOR_HOOK_SPOOL_DIR: spool },
    timeout: 10_000,
  });
  const deadline = Date.now() + 5_000;
  while (!fs.readdirSync(spool).some(name => name.endsWith('.json'))) {
    assert.ok(Date.now() < deadline, 'the hook spooled its event');
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  assert.deepEqual(drainHookSpool(spool), { ingested: 1, duplicates: 0, rejected: 0, errors: 0 });
  const row = getDb().prepare("SELECT session_id, tool_name, source, event_id, client_timestamp FROM events WHERE session_id = 'spool-e2e'")
    .get() as Record<string, string>;
  assert.equal(row.tool_name, 'Grep');
  assert.equal(row.source, 'hook');
  assert.ok(row.event_id && row.client_timestamp);
  assert.deepEqual(fs.readdirSync(spool), []);
});

test('a hook with no date command still spools a file the drain reads', () => {
  // send_event.sh names the file `0-<id>.json` when it cannot tell the time.
  spooled('0-hook-123-45678.json', event('no-clock', '2026-11-11T05:30:00Z'));
  assert.deepEqual(drainHookSpool(spool), { ingested: 1, duplicates: 0, rejected: 0, errors: 0 });
  assert.deepEqual(fs.readdirSync(spool), []);
});

const lifecycle = (id: string, extra: Record<string, unknown>) => JSON.stringify({
  session_id: 'replay-session', agent_type: 'claude_code', source: 'hook', metadata: {}, event_id: id, ...extra,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const replaySession = () => getDb().prepare("SELECT status, last_event_at FROM sessions WHERE id = 'replay-session'")
  .get() as { status: string; last_event_at: string };
function postLive(json: string): void {
  const parsed = normalizeIngestEvent(JSON.parse(json));
  assert.ok(parsed.ok);
  insertEvent(parsed.event);
}

test('a late Stop does not idle a session that has worked since', () => {
  postLive(lifecycle('live-tool', { event_type: 'tool_use', tool_name: 'Bash' }));
  const before = replaySession();
  spooled('1762839000-old-stop.json', lifecycle('old-stop', { event_type: 'session_end', client_timestamp: minutesAgo(2) }));

  assert.deepEqual(drainHookSpool(spool), { ingested: 1, duplicates: 0, rejected: 0, errors: 0 });
  assert.deepEqual(replaySession(), before, 'still active, still last active when it was');
});

test('a late tool call does not reactivate a session that has stopped since', () => {
  postLive(lifecycle('live-tool-2', { event_type: 'tool_use', tool_name: 'Bash' }));
  postLive(lifecycle('live-stop', { event_type: 'session_end' }));
  assert.equal(replaySession().status, 'idle');
  spooled('1762839000-old-tool.json', lifecycle('old-tool', { event_type: 'tool_use', tool_name: 'Read', client_timestamp: minutesAgo(2) }));

  drainHookSpool(spool);
  assert.equal(replaySession().status, 'idle');
});

test('spooled events of one session replay in the order they happened', () => {
  // The order key is the hook's own clock, finer than the second: a Stop just
  // after a tool call in the same second sorts after it, whatever its id says.
  const at = minutesAgo(1);
  spooled('1762839000000200-aaaa.json', lifecycle('stop-later', { event_type: 'session_end', client_timestamp: at }));
  spooled('1762839000000100-zzzz.json', lifecycle('tool-first', { event_type: 'tool_use', tool_name: 'Edit', client_timestamp: at }));

  drainHookSpool(spool);
  assert.deepEqual(getDb().prepare("SELECT event_id FROM events WHERE session_id = 'replay-session' ORDER BY id").all(),
    [{ event_id: 'tool-first' }, { event_id: 'stop-later' }]);
  assert.equal(replaySession().status, 'idle', 'the Stop, being last, leaves the session idle');
});

test('a tool call and the Stop right after it, spooled by the real hooks, replay in that order', async () => {
  const { execFileSync } = await import('node:child_process');
  const hooks = path.resolve(import.meta.dirname, '..', 'hooks', 'claude-code');
  const run = (script: string, input: Record<string, unknown>) => execFileSync('bash', [path.join(hooks, script)], {
    input: JSON.stringify({ session_id: 'burst', cwd: tempDir, ...input }),
    env: { ...process.env, AGENTMONITOR_URL: 'http://127.0.0.1:9', AGENTMONITOR_HOOK_SPOOL_DIR: spool },
    timeout: 10_000,
  });
  run('post_tool_use.sh', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/x' }, tool_response: {} });
  run('session_end.sh', { hook_event_name: 'Stop' });
  const deadline = Date.now() + 5_000;
  while (fs.readdirSync(spool).filter(name => name.endsWith('.json')).length < 2) {
    assert.ok(Date.now() < deadline, 'both hooks spooled their event');
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  assert.equal(drainHookSpool(spool).ingested, 2);
  assert.deepEqual(getDb().prepare("SELECT event_type FROM events WHERE session_id = 'burst' ORDER BY id").all(),
    [{ event_type: 'tool_use' }, { event_type: 'session_end' }]);
  assert.equal((getDb().prepare("SELECT status FROM sessions WHERE id = 'burst'").get() as { status: string }).status, 'idle');
});
