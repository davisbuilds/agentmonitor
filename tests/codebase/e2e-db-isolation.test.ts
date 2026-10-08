import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e');
const IMPORTS_SRC = /['"](?:\.\.\/)+src\//;

// Playwright runs several spec files in one worker, and `config` snapshots the
// database path on first import. A spec that boots the app in-process without
// useIsolatedDb() reads the previous file's database: in CI, with one worker,
// such specs failed their first attempt and passed on a retry in a fresh worker.
test('every e2e spec that boots the app in-process opens its own database', () => {
  // Playwright discovers specs in subdirectories too, which reach src/ through more `../`.
  const specs = (fs.readdirSync(E2E_ROOT, { recursive: true }) as string[]).filter(name => name.endsWith('.spec.ts'));
  const inProcess = specs.filter(name => IMPORTS_SRC.test(fs.readFileSync(path.join(E2E_ROOT, name), 'utf8')));
  // A floor, so a renamed directory or import style cannot pass with nothing checked.
  assert.ok(inProcess.length >= 8, `expected at least 8 in-process specs, found ${inProcess.length}`);

  const offenders = inProcess.filter(name => {
    const source = fs.readFileSync(path.join(E2E_ROOT, name), 'utf8');
    return !source.includes('useIsolatedDb(') || /AGENTMONITOR_DB_PATH\s*=/.test(source);
  });
  assert.deepEqual(offenders, [], 'call useIsolatedDb() from e2e/isolated-db.ts instead of setting AGENTMONITOR_DB_PATH');
});
