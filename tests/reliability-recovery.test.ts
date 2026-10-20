import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Isolate the DB before importing anything that reads config. Children inherit it.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-reliability-recovery-'));
const dbPath = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_DB_PATH = dbPath;
process.env.AGENTMONITOR_PROJECTS_DIR = tempDir;

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { getMonitorSessionTranscript } = await import('../src/db/v2-queries.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const READY_TIMEOUT_MS = 30_000;
const children = new Set<ChildProcess>();

function count(sql: string, ...params: unknown[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n;
}

function assertOpenedTempDb(): void {
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(dbPath), 'the opened handle is the temp database');
}

function hookEvent(eventId: string, sessionId: string, extra: { client_timestamp?: string; command?: string } = {}) {
  return {
    event_id: eventId, session_id: sessionId, agent_type: 'claude_code', event_type: 'tool_use' as const,
    tool_name: 'Bash', status: 'success' as const, tokens_in: 1, tokens_out: 1, source: 'hook',
    metadata: extra.command ? { command: extra.command } : {}, client_timestamp: extra.client_timestamp,
  };
}

// Child preamble: open the temp database, refuse any other, and expose a way to
// stop forever at the point the parent kills it.
const CHILD_PRELUDE = String.raw`
  import fs from 'node:fs';

  const [, dbPath, readyPath] = process.argv;
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  const { getDb } = await import('./src/db/connection.ts');
  const db = getDb();
  if (fs.realpathSync(db.name) !== fs.realpathSync(dbPath)) throw new Error('opened ' + db.name + ', not ' + dbPath);
  const hangUntilKilled = () => {
    fs.writeFileSync(readyPath, 'ready');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(cell, 0, 0, 1_000);
  };
`;

/** Run `body` in a child until it reports it is inside its transaction, then SIGKILL it. */
async function killWhenReady(name: string, body: string): Promise<void> {
  const readyPath = path.join(tempDir, `${name}.ready`);
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', CHILD_PRELUDE + body, dbPath, readyPath,
  ], { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  child.stderr!.on('data', chunk => { output += chunk.toString(); });
  let closed = false;
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => { closed = true; resolve({ status, signal }); });
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!fs.existsSync(readyPath) && !closed && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const ready = fs.existsSync(readyPath);
  if (!closed) child.kill('SIGKILL');
  const { status, signal } = await exited;
  children.delete(child);
  assert.ok(ready, `${name}: the child never reached its interruption point (status ${status}):\n${output}`);
  assert.equal(signal, 'SIGKILL', `${name}: the child was killed mid-transaction:\n${output}`);
}

before(() => {
  initSchema();
  assertOpenedTempDb();
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a writer killed inside its transaction leaves only what it committed, and a restart accepts the retry', async () => {
  closeDb();
  await killWhenReady('ingest', String.raw`
    const { insertEvent } = await import('./src/db/queries.ts');
    const event = (eventId, sessionId) => ({
      event_id: eventId, session_id: sessionId, agent_type: 'claude_code', event_type: 'tool_use',
      tool_name: 'Bash', status: 'success', tokens_in: 1, tokens_out: 1, metadata: {}, source: 'hook',
    });
    if (!insertEvent(event('rr-kill-committed', 'rr-kill'))) throw new Error('the committed insert was skipped');
    // A caller's batch transaction, as the Codex reconcile wraps its inserts.
    db.transaction(() => {
      if (!insertEvent(event('rr-kill-pending', 'rr-kill'))) throw new Error('pending insert skipped');
      if (!insertEvent(event('rr-kill-orphan', 'rr-kill-orphan'))) throw new Error('orphan insert skipped');
      hangUntilKilled();
    })();
  `);

  // Restart: a fresh connection recovers the WAL the killed writer left behind.
  initSchema();
  assertOpenedTempDb();
  assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE event_id = ?', 'rr-kill-committed'), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE event_id IN (?, ?)', 'rr-kill-pending', 'rr-kill-orphan'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', 'rr-kill-orphan'), 0, 'no session without its event');

  // The killed process held no lock that outlives it, and its uncommitted ids
  // are not duplicates: the producer's retry is stored, once.
  assert.ok(insertEvent(hookEvent('rr-kill-pending', 'rr-kill')));
  assert.equal(insertEvent(hookEvent('rr-kill-pending', 'rr-kill')), null);
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', 'rr-kill'), 2);
});

test('a migration killed before it records its version rolls back, and the restart applies it once', async () => {
  assertOpenedTempDb();
  const version = getDb().pragma('user_version', { simple: true }) as number;
  assert.ok(version > 0);
  // The v1 correction is not self-idempotent: 100k cache-inclusive input with
  // 40k cache reads becomes 60k once, and 20k if it ever ran twice.
  getDb().prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      model, cost_usd, cache_read_tokens, cache_write_tokens, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('rr-migration-backfill', 'rr-migration', 'codex', 'llm_response', 'success',
    100_000, 0, 'gpt-5.4', 1.01, 40_000, 0, 'import');
  getDb().pragma('user_version = 0');
  closeDb();

  // Every correction has run inside the startup transaction; stop at the
  // version bump that would commit them.
  await killWhenReady('migration', String.raw`
    const { initSchema } = await import('./src/db/schema.ts');
    const pragma = db.pragma.bind(db);
    db.pragma = (source, options) => {
      if (/^user_version\s*=/.test(String(source))) hangUntilKilled();
      return pragma(source, options);
    };
    initSchema();
  `);

  const tokensIn = () => (getDb().prepare('SELECT tokens_in FROM events WHERE event_id = ?')
    .get('rr-migration-backfill') as { tokens_in: number }).tokens_in;
  assertOpenedTempDb();
  assert.equal(getDb().pragma('user_version', { simple: true }), 0, 'the interrupted run recorded no version');
  assert.equal(tokensIn(), 100_000, 'the interrupted correction rolled back');
  closeDb();

  initSchema();
  assertOpenedTempDb();
  assert.equal(getDb().pragma('user_version', { simple: true }), version);
  assert.equal(tokensIn(), 60_000, 'the retried correction applied once');
  closeDb();
  initSchema();
  assert.equal(tokensIn(), 60_000, 'a further restart does not reapply it');
  assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok');
});

test('events delivered out of client order each keep their own time and read back the same way every time', () => {
  // The contract persists both the client and the receive time; it does not
  // promise an order by either, so this asserts membership and stability only.
  const sessionId = 'rr-order';
  const delivered = [
    { id: 'rr-order-3', at: '2026-10-19T12:00:03.000Z' },
    { id: 'rr-order-1', at: '2026-10-19T12:00:01.000Z' },
    { id: 'rr-order-2', at: '2026-10-19T12:00:02.000Z' },
  ];
  for (const { id, at } of delivered) {
    assert.ok(insertEvent(hookEvent(id, sessionId, { client_timestamp: at, command: id })));
  }
  // The earliest event, resent late, is still the one stored copy.
  assert.equal(insertEvent(hookEvent('rr-order-1', sessionId, {
    client_timestamp: '2026-10-19T12:00:09.000Z', command: 'rr-order-1-resent',
  })), null);

  const stored = getDb().prepare(`
    SELECT event_id, client_timestamp, created_at FROM events WHERE session_id = ? ORDER BY event_id
  `).all(sessionId) as Array<{ event_id: string; client_timestamp: string; created_at: string | null }>;
  assert.deepEqual(
    stored.map(row => [row.event_id, row.client_timestamp]),
    [...delivered].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, at }) => [id, at]),
  );
  for (const row of stored) assert.ok(row.created_at, `${row.event_id} has a receive time`);

  const transcript = getMonitorSessionTranscript(sessionId);
  assert.ok(transcript);
  assert.deepEqual(
    new Map(transcript.entries.map(entry => [entry.detail, entry.timestamp])),
    new Map(delivered.map(({ id, at }) => [id, at])),
  );
  assert.equal(transcript.entries.length, delivered.length);
  assert.deepEqual(getMonitorSessionTranscript(sessionId), transcript);
});
