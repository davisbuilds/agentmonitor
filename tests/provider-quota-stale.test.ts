import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-quota-stale-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { upsertProviderQuotaSnapshot, getProviderQuotas } = await import('../src/db/queries.js');
const { getMonitorStats } = await import('../src/db/v2-queries.js');

initSchema();
assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  // The delete below is table-wide: confirm it runs against this test's file.
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  db.exec('DELETE FROM provider_quotas');
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();
const codex = () => getProviderQuotas().find(row => row.provider === 'codex')!;

function goodRead(minute: number, usedPercent: number) {
  upsertProviderQuotaSnapshot({
    provider: 'codex',
    status: 'available',
    source: 'codex-app-server',
    updated_at: at(minute),
    plan_type: 'pro',
    primary: { used_percent: usedPercent, resets_at: '2026-11-11T15:00:00.000Z', window_minutes: 300 },
    secondary: { used_percent: 30, resets_at: '2026-11-15T15:00:00.000Z', window_minutes: 10080 },
    credits: { has_credits: true, unlimited: false, balance: '5' },
  });
}

function failedRead(minute: number) {
  upsertProviderQuotaSnapshot({
    provider: 'codex',
    status: 'error',
    source: 'codex-app-server',
    updated_at: at(minute),
    error_message: 'Timed out waiting for Codex quota response after 5000ms',
  });
}

test('a failed refresh keeps the last good windows, marked stale with when they were read', () => {
  goodRead(0, 40);
  assert.equal(codex().stale, false);
  assert.equal(codex().windows_observed_at, at(0));

  failedRead(1);
  const row = codex();
  assert.equal(row.status, 'error');
  assert.equal(row.error_message, 'Timed out waiting for Codex quota response after 5000ms');
  assert.equal(row.updated_at, at(1), 'the failed attempt is still the latest update');
  assert.equal(row.stale, true);
  assert.equal(row.windows_observed_at, at(0));
  assert.equal(row.primary?.used_percent, 40);
  assert.equal(row.secondary?.window_minutes, 10080);
  assert.equal(row.plan_type, 'pro');
  assert.deepEqual(row.credits, { has_credits: true, unlimited: false, balance: '5' });

  // Failing again keeps the same reading and its age.
  failedRead(2);
  assert.equal(codex().windows_observed_at, at(0));
  assert.equal(codex().primary?.used_percent, 40);

  // The Monitor's stats read the same snapshot.
  const monitorCodex = getMonitorStats().quota_monitor.find(row => row.provider === 'codex')!;
  assert.deepEqual(monitorCodex, codex());

  goodRead(3, 55);
  assert.equal(codex().stale, false);
  assert.equal(codex().windows_observed_at, at(3));
  assert.equal(codex().primary?.used_percent, 55);
});

test('a failed refresh with no earlier reading has no windows and is not stale', () => {
  failedRead(0);
  const row = codex();
  assert.equal(row.status, 'error');
  assert.equal(row.primary, null);
  assert.equal(row.stale, false);
  assert.equal(row.windows_observed_at, null);
});

test('an unavailable snapshot still clears the windows', () => {
  goodRead(0, 40);
  upsertProviderQuotaSnapshot({ provider: 'codex', status: 'unavailable', updated_at: at(1) });
  assert.equal(codex().primary, null);
  assert.equal(codex().stale, false);
});

test('v30 dates the windows a store already holds by their update time', async () => {
  const { runDataMigrations } = await import('../src/db/schema.js');
  const db = getDb();
  goodRead(0, 40);
  db.exec('UPDATE provider_quotas SET windows_observed_at = NULL; PRAGMA user_version = 29');
  runDataMigrations(db);
  assert.equal(codex().windows_observed_at, at(0));
  assert.equal(db.pragma('user_version', { simple: true }), 30);
});
