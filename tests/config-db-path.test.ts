import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { createConfig } from '../src/config.js';
import { resolveDbPath } from '../src/db-path.js';

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

  // `amon status` reports on the DB it resolves itself. When it kept its own copy
  // of the default, a server started from a non-repo cwd was healthy and reading
  // the install DB while status pointed at a cwd-relative file that did not exist.
  test('the server and `amon status` resolve the same default', () => {
    assert.equal(resolveDbPath({}), createConfig({}, '/anywhere').dbPath);
  });

  test('the server and `amon status` agree on an explicit path', () => {
    const env = { AGENTMONITOR_DB_PATH: '/tmp/custom.db' };
    assert.equal(resolveDbPath(env), createConfig(env, '/anywhere').dbPath);
  });
});
