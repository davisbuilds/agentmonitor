import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import {
  buildServiceSpec,
  installService,
  restartService,
  serviceStatus,
  uninstallService,
  SERVICE_LABEL,
  type CommandResult,
  type LaunchdHost,
} from '../src/cli/launchd.js';
import { CliError } from '../src/cli/errors.js';
import { acquireRuntimeOwnership, readRuntimeOwner } from '../src/runtime-ownership.js';

const onMac = process.platform === 'darwin';

/** A temp home, a built-looking install, and a launchctl that keeps its state in memory. */
function fixture(options: { platform?: NodeJS.Platform; servicePid?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-launchd-'));
  const home = path.join(root, 'home');
  const install = path.join(root, 'install & co');
  fs.mkdirSync(path.join(install, 'dist'), { recursive: true });
  fs.mkdirSync(home);
  const entryScript = path.join(install, 'dist', 'cli.js');
  fs.writeFileSync(entryScript, '');
  const dbPath = path.join(root, 'data', 'agentmonitor.db');
  fs.mkdirSync(path.dirname(dbPath));

  const calls: string[][] = [];
  const service = { loaded: false, pid: options.servicePid ?? 4242, onBootout: () => {}, ownedAtBootstrap: [] as boolean[] };
  const run = (command: string, args: string[]): CommandResult => {
    if (command === 'plutil') {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    calls.push([command, ...args]);
    const [verb] = args;
    if (verb === 'print') {
      return service.loaded
        ? { status: 0, stdout: `${SERVICE_LABEL} = {\n\tstate = running\n\tpid = ${service.pid}\n\tlast exit code = 0\n}\n`, stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (verb === 'bootout') {
      service.loaded = false;
      service.onBootout();
    }
    if (verb === 'bootstrap') {
      service.loaded = true;
      service.ownedAtBootstrap.push(readRuntimeOwner(dbPath) !== null);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const host: LaunchdHost = { platform: options.platform ?? 'darwin', uid: 501, home, run, stopTimeoutMs: 2_000 };
  const env = {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: home,
    CODEX_HOME: '/somewhere/.codex',
    AGENTMONITOR_DB_PATH: dbPath,
    AGENTMONITOR_EXECUTIONS_DIR: '/state/executions',
    AGENTMONITOR_OPENAI_API_KEY: 'sk-not-recorded',
    AGENTMONITOR_WAREHOUSE_DSN: 'postgres://user:pw@host/db',
    AGENTMONITOR_PORTLESS_CLI: '/test/seam',
    AGENTMONITOR_TEST_CLI_ENTRYPOINT: 'dist/cli.js',
    OPENAI_API_KEY: 'sk-not-recorded-either',
  };
  const spec = () => buildServiceSpec({ host, nodePath: '/usr/local/bin/node', entryScript, env, cwd: root });
  const plistJson = (file: string) => JSON.parse(
    spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout,
  ) as Record<string, unknown>;
  return { root, home, install, entryScript, dbPath, calls, service, host, env, spec, plistJson };
}

describe('amon service (launchd)', () => {
  test('records PATH and the AGENTMONITOR_* settings in effect, but no secret and no test seam', () => {
    const { spec, install, entryScript } = fixture();
    const built = spec();
    assert.deepEqual(built.environment, {
      AGENTMONITOR_DB_PATH: built.dbPath,
      AGENTMONITOR_EXECUTIONS_DIR: '/state/executions',
      CODEX_HOME: '/somewhere/.codex',
      PATH: '/opt/homebrew/bin:/usr/bin',
    });
    assert.deepEqual(built.skippedSecrets, ['AGENTMONITOR_OPENAI_API_KEY', 'AGENTMONITOR_WAREHOUSE_DSN']);
    assert.deepEqual(built.programArguments, ['/usr/local/bin/node', fs.realpathSync(entryScript), 'serve', '--no-portless']);
    assert.equal(built.workingDirectory, fs.realpathSync(install));
  });

  test('resolves a relative database path against the shell that installs, not the install root', () => {
    const { host, entryScript, root, env } = fixture();
    const built = buildServiceSpec({
      host, nodePath: 'node', entryScript, env: { ...env, AGENTMONITOR_DB_PATH: 'elsewhere/my.db' }, cwd: root,
    });
    assert.equal(built.environment.AGENTMONITOR_DB_PATH, path.join(root, 'elsewhere', 'my.db'));
    assert.equal(built.dbPath, path.join(root, 'elsewhere', 'my.db'));
  });

  test('refuses to install from source or from a script outside dist/', () => {
    const { host, install, env, root } = fixture();
    for (const name of ['src/cli.ts', 'scripts/cli.js']) {
      const script = path.join(install, name);
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '');
      assert.throws(
        () => buildServiceSpec({ host, nodePath: 'node', entryScript: script, env, cwd: root }),
        /runs the built CLI/,
        name,
      );
    }
  });

  test('writes a valid plist that restarts a crashed server but not a stopped one', { skip: !onMac }, async () => {
    const { host, spec, plistJson, calls } = fixture();
    const built = spec();
    await installService(host, built);

    const lint = spawnSync('plutil', ['-lint', built.plistPath], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const plist = plistJson(built.plistPath);
    assert.equal(plist.Label, SERVICE_LABEL);
    assert.deepEqual(plist.ProgramArguments, built.programArguments, 'paths with & survive escaping');
    assert.deepEqual(plist.EnvironmentVariables, built.environment);
    assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.StandardErrorPath, built.logPath);
    assert.ok(fs.statSync(path.dirname(built.logPath)).isDirectory());
    assert.doesNotMatch(fs.readFileSync(built.plistPath, 'utf8'), /sk-not-recorded|user:pw/);
    assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', built.plistPath]);
  });

  test('refuses while a server the service does not run owns the database', async () => {
    const { host, spec, dbPath, calls } = fixture();
    const built = spec();
    const owner = acquireRuntimeOwnership(dbPath);
    try {
      await assert.rejects(installService(host, built), /already serves/);
      assert.equal(fs.existsSync(built.plistPath), false);
      assert.ok(!calls.some(call => call[1] === 'bootstrap'));
    } finally {
      owner.release();
    }
  });

  test('a reinstall stops the service, waits for it to release the database, then starts the new one', async () => {
    const { host, spec, dbPath, calls, service } = fixture({ servicePid: process.pid });
    const built = spec();
    await installService(host, built);
    // The running service is this process, holding the database.
    const owner = acquireRuntimeOwnership(dbPath);
    service.onBootout = () => setTimeout(() => owner.release(), 200);
    calls.length = 0;

    await installService(host, built);
    assert.deepEqual(calls.map(call => call[1]), ['print', 'bootout', 'bootstrap']);
    assert.deepEqual(service.ownedAtBootstrap, [false, false], 'the new server never starts against a held database');
  });

  test('restart kicks a loaded service and reports a missing one as not found', async () => {
    const { host, spec, calls } = fixture();
    assert.throws(() => restartService(host), (error: unknown) => error instanceof CliError && error.exitCode === 4);
    await installService(host, spec());
    restartService(host);
    assert.deepEqual(calls.at(-1), ['launchctl', 'kickstart', '-k', `gui/501/${SERVICE_LABEL}`]);
  });

  test('uninstall stops the service and removes its plist, and says when there was none', async () => {
    const { host, spec } = fixture();
    const built = spec();
    assert.equal(uninstallService(host), false);
    await installService(host, built);
    assert.equal(uninstallService(host), true);
    assert.equal(fs.existsSync(built.plistPath), false);
    assert.equal(serviceStatus(host).loaded, false);
  });

  test('status reads the pid and notices when the recorded CLI is gone', { skip: !onMac }, async () => {
    const { host, spec, entryScript } = fixture();
    await installService(host, spec());
    const status = serviceStatus(host);
    assert.equal(status.state, 'running');
    assert.equal(status.pid, 4242);
    assert.equal(status.entry_exists, true);
    fs.rmSync(entryScript);
    assert.equal(serviceStatus(host).entry_exists, false);
  });

  test('refuses off macOS, and refuses to touch the real home from a test', () => {
    const { host } = fixture({ platform: 'linux' });
    assert.throws(() => serviceStatus(host), /not macOS/);
    const real: LaunchdHost = { ...fixture().host, home: os.homedir() };
    assert.throws(() => serviceStatus(real), /real launchd agent/);
  });
});
