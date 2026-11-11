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
