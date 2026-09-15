#!/usr/bin/env tsx
/** Offline, opt-in repair. Back up and stop writers first; see OPERATIONS.md. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repairSummaryTimestamps } from '../src/db/repair-summary-timestamps.js';

try {
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, apply: { type: 'boolean' },
    'expect-digest': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: pnpm exec tsx scripts/repair-summary-timestamps.ts --db /absolute/database.db [--apply --expect-digest SHA256]\nDefaults to read-only JSON preview. Back up and stop all writers before apply.');
  } else {
    if (!values.db || !path.isAbsolute(values.db) || !fs.lstatSync(values.db).isFile()) {
      throw new Error('An absolute, existing regular database file is required');
    }
    if (values.apply ? !/^[a-f0-9]{64}$/.test(values['expect-digest'] ?? '') : values['expect-digest'] !== undefined) {
      throw new Error('--apply requires --expect-digest from a reviewed preview');
    }
    const db = new Database(values.db, { readonly: !values.apply, fileMustExist: true });
    try {
      db.pragma('foreign_keys = ON');
      console.log(JSON.stringify(repairSummaryTimestamps(db, values.apply ? values['expect-digest'] : undefined)));
    } finally { db.close(); }
  }
} catch {
  console.error('Timestamp repair failed. Check arguments, database access and preview digest; inspect a fresh preview before retrying.');
  process.exitCode = 1;
}
