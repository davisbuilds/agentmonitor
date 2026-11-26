import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { createConfig } from '../src/config.js';
import { assertTestDbIsIsolated } from '../src/db/connection.js';
import { resolveDbPath } from '../src/db-path.js';

describe('config: default database path', () => {
  test('does not depend on the working directory', () => {
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

  // WHY: A status command launched outside the repo must resolve the same database as the service or
  // it can contradict a healthy server.
  test('the server and `amon status` resolve the same default', () => {
    assert.equal(resolveDbPath({}), createConfig({}, '/anywhere').dbPath);
  });

  test('the server and `amon status` agree on an explicit path', () => {
    const env = { AGENTMONITOR_DB_PATH: '/tmp/custom.db' };
    assert.equal(resolveDbPath(env), createConfig(env, '/anywhere').dbPath);
  });
});

describe('db: tests cannot open the install database', () => {
  const underTest = { NODE_TEST_CONTEXT: 'child-v8' } satisfies NodeJS.ProcessEnv;
  const installDb = resolveDbPath({});

  test('opening the install database from a test throws', () => {
    assert.throws(
      () => assertTestDbIsIsolated(installDb, underTest),
      /Refusing to open the install database/,
    );
  });

  test('an isolated temp database is allowed', () => {
    assert.doesNotThrow(() => assertTestDbIsIsolated('/tmp/scratch/agentmonitor.db', underTest));
  });

  test('the server may open the install database', () => {
    assert.doesNotThrow(() => assertTestDbIsIsolated(installDb, {}));
  });
});
