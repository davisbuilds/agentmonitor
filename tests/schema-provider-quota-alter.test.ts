import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { closeDb as closeDbType, getDb as getDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let initSchema: typeof initSchemaType;
let closeDb: typeof closeDbType;
let getDb: typeof getDbType;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-provider-quota-alter-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'legacy.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('initSchema adds missing provider quota columns without dropping provider-keyed rows', () => {
  const db = getDb();
  db.exec(`
    CREATE TABLE provider_quotas (
      provider TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      updated_at TEXT
    );
    INSERT INTO provider_quotas (provider, agent_type, updated_at)
    VALUES ('claude', 'claude_code', '2026-03-01T00:00:00Z');
  `);

  initSchema();

  const columns = new Set(
    (db.prepare('PRAGMA table_info(provider_quotas)').all() as Array<{ name: string }>).map(col => col.name),
  );
  for (const column of [
    'status',
    'source',
    'updated_at',
    'account_label',
    'plan_type',
    'limit_id',
    'limit_name',
    'error_message',
    'primary_used_percent',
    'primary_window_minutes',
    'primary_resets_at',
    'secondary_used_percent',
    'secondary_window_minutes',
    'secondary_resets_at',
    'credits_has_credits',
    'credits_unlimited',
    'credits_balance',
    'raw_payload',
  ]) {
    assert.ok(columns.has(column), `missing provider_quotas.${column}`);
  }

  const row = db.prepare('SELECT provider, agent_type, status, updated_at FROM provider_quotas WHERE provider = ?')
    .get('claude') as { provider: string; agent_type: string; status: string; updated_at: string };
  assert.deepEqual(row, {
    provider: 'claude',
    agent_type: 'claude_code',
    status: 'unavailable',
    updated_at: '2026-03-01T00:00:00Z',
  });
});
