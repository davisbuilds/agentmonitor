import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-quota-samples-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { upsertProviderQuotaSnapshot } = await import('../src/db/queries.js');

initSchema();
assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM provider_quota_samples');
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 10, minute)).toISOString();
const weekly = '2026-11-04T15:00:00.000Z';

function codex(minute: number, usedPercent: number, resetsAt = weekly) {
  upsertProviderQuotaSnapshot({
    provider: 'codex',
    status: 'available',
    updated_at: at(minute),
    primary: { used_percent: usedPercent, resets_at: resetsAt, window_minutes: 10080 },
  });
}

function samples(provider = 'codex') {
  return getDb().prepare(`SELECT sampled_at, observed_until, primary_used_percent AS used, primary_resets_at AS resets
    FROM provider_quota_samples WHERE provider = ? ORDER BY id`).all(provider);
}

test('a reading that moves is sampled at most once per five minutes', () => {
  codex(0, 40);
  codex(1, 41); // too soon after the last row
  codex(3, 42);
  codex(5, 43);
  codex(7, 44);
  codex(10, 45);
  assert.deepEqual(samples().map(row => [row.sampled_at, row.used]), [
    [at(0), 40], [at(5), 43], [at(10), 45],
  ]);
});

test('a reading that holds extends the latest row instead of adding one', () => {
  codex(0, 40);
  for (let minute = 1; minute <= 30; minute++) codex(minute, 40);
  codex(33, 40); // too soon to move observed_until again
  codex(42, 46);
  assert.deepEqual(samples().map(row => [row.sampled_at, row.observed_until, row.used]), [
    // observed_until moves at most once per interval, and the idle stretch stays flat.
    [at(0), at(30), 40],
    [at(42), at(42), 46],
  ]);
});

test('a window reset starts a row like any other change', () => {
  const next = '2026-11-11T15:00:00.000Z';
  codex(0, 97);
  codex(6, 0, next);
  // An unused window rolling over moves no percentage, only its reset.
  codex(12, 0, '2026-11-18T15:00:00.000Z');
  assert.deepEqual(samples().map(row => [row.used, row.resets]), [[97, weekly], [0, next], [0, '2026-11-18T15:00:00.000Z']]);
});

test('providers are sampled apart, and a reading with no usage is not sampled', () => {
  codex(0, 40);
  upsertProviderQuotaSnapshot({
    provider: 'claude',
    updated_at: at(1),
    primary: { used_percent: 20, resets_at: '2026-10-30T15:00:00.000Z', window_minutes: 300 },
    secondary: { used_percent: 42, resets_at: weekly, window_minutes: 10080 },
  });
  upsertProviderQuotaSnapshot({ provider: 'codex', status: 'error', updated_at: at(9), error_message: 'app-server down' });
  assert.equal(samples('codex').length, 1);
  assert.deepEqual(getDb().prepare(`SELECT primary_used_percent, secondary_used_percent, secondary_window_minutes
    FROM provider_quota_samples WHERE provider = 'claude'`).all(), [
    { primary_used_percent: 20, secondary_used_percent: 42, secondary_window_minutes: 10080 },
  ]);
});

test('a read command on a store from before quota history still gets the table', async () => {
  const { ensureSchemaForRead } = await import('../src/db/schema.js');
  const db = getDb();
  // Read commands skip DDL once user_version is current, so the table only arrives if the version moves past it.
  db.exec('DROP TABLE provider_quota_samples; PRAGMA user_version = 24');
  ensureSchemaForRead();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'provider_quota_samples'").get());
  assert.equal(db.pragma('user_version', { simple: true }), 25);
});
