import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { createConfig } from '../src/config.js';

describe('config: default database path', () => {
  test('does not depend on the working directory', () => {
    // Launching from the wrong directory used to silently create a second,
    // empty database there and auto-import into it.
    const fromRepo = createConfig({}, '/Users/dev/agentmonitor');
    const fromElsewhere = createConfig({}, '/Users/dev');
    const fromRoot = createConfig({}, '/');

    assert.equal(fromRepo.dbPath, fromElsewhere.dbPath);
    assert.equal(fromRepo.dbPath, fromRoot.dbPath);
  });

  test('resolves to an absolute path inside the install', () => {
    const { dbPath } = createConfig({}, '/somewhere/else');
    assert.ok(path.isAbsolute(dbPath), `expected an absolute path, got ${dbPath}`);
    assert.equal(path.basename(dbPath), 'agentmonitor.db');
    assert.equal(path.basename(path.dirname(dbPath)), 'data');
  });

  test('an explicit AGENTMONITOR_DB_PATH still wins', () => {
    const { dbPath } = createConfig({ AGENTMONITOR_DB_PATH: '/tmp/custom.db' }, '/anywhere');
    assert.equal(dbPath, '/tmp/custom.db');
  });
});
