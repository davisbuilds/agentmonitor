import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import pkg from '../package.json' with { type: 'json' };
import { parseCli } from '../src/cli/args.js';
import { main } from '../src/cli.js';

class CaptureStream extends Writable {
  output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

test('package exposes both short and explicit CLI executables', () => {
  assert.equal(pkg.bin?.amon, './dist/cli.js');
  assert.equal(pkg.bin?.agentmonitor, './dist/cli.js');
});

test('parseCli normalizes direct cli.js execution to amon', () => {
  const parsed = parseCli(['/usr/local/bin/node', '/repo/dist/cli.js', '--json', '--db-path', '/tmp/test.db', 'sessions', 'list']);

  assert.equal(parsed.commandName, 'amon');
  assert.equal(parsed.global.json, true);
  assert.equal(parsed.global.dbPath, '/tmp/test.db');
  assert.deepEqual(parsed.args, ['sessions', 'list']);
});

test('parseCli ignores the pnpm script separator before global flags', () => {
  const parsed = parseCli(['/usr/local/bin/node', '/repo/dist/cli.js', '--', '--json', 'warehouse', 'publish', '--dry-run']);

  assert.equal(parsed.global.json, true);
  assert.deepEqual(parsed.args, ['warehouse', 'publish', '--dry-run']);
});

test('root help prints amon usage', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: amon \[global flags\] <command> \[args\]/);
  assert.match(result.stdout, /Both 'amon' and 'agentmonitor' run this CLI/);
  assert.equal(result.stderr, '');
});

test('version prints package version to stdout', async () => {
  const result = await runCli(['--version']);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), pkg.version);
  assert.equal(result.stderr, '');
});

test('unknown commands exit with invalid usage', async () => {
  const result = await runCli(['nope']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: nope/);
});

test('a command group prints its subcommands for --help', async () => {
  const result = await runCli(['service', '--help']);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: amon service <subcommand> \[args\]/);
  for (const subcommand of ['install', 'restart', 'status', 'uninstall']) {
    assert.match(result.stdout, new RegExp(`^  service ${subcommand} `, 'm'));
  }
  assert.doesNotMatch(result.stdout, /^ {2}sessions /m, 'lists only the group asked for');
});

test('help <group> prints the same subcommand list', async () => {
  const viaFlag = await runCli(['service', '--help']);
  const viaHelp = await runCli(['help', 'service']);

  assert.equal(viaHelp.exitCode, 0);
  assert.equal(viaHelp.stdout, viaFlag.stdout);
});

test('help <command> prints that command\'s own help', async () => {
  const viaFlag = await runCli(['service', 'status', '--help']);
  const viaHelp = await runCli(['help', 'service', 'status']);

  assert.equal(viaHelp.exitCode, 0);
  assert.match(viaFlag.stdout, /^Usage: amon service status/m);
  assert.equal(viaHelp.stdout, viaFlag.stdout);
});

test('help for an unknown command exits with invalid usage', async () => {
  const result = await runCli(['help', 'nope']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: nope/);
});

test('a bare command group exits with invalid usage and names its subcommands', async () => {
  const result = await runCli(['service']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /amon service needs a subcommand: install, restart, status, uninstall/);
  assert.match(result.stderr, /amon service --help/);
});

test('an unknown subcommand names the group and its subcommands', async () => {
  const result = await runCli(['service', 'stopp']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: service stopp/);
  assert.match(result.stderr, /install, restart, status, uninstall/);
});

test('a flag after a bare group is not read as a subcommand', async () => {
  const result = await runCli(['service', '--force']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /amon service needs a subcommand/);
});
