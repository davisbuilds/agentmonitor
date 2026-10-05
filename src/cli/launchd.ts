import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDbPath } from '../db-path.js';
import { readRuntimeOwner } from '../runtime-ownership.js';
import { CliError, notFound, unavailable } from './errors.js';

export const SERVICE_LABEL = 'dev.agentmonitor.serve';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The machine the service is installed on. Tests substitute every part of it. */
export interface LaunchdHost {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  run: (command: string, args: string[]) => CommandResult;
  /** How long to wait for a stopped server to release the database. */
  stopTimeoutMs: number;
}

export function currentLaunchdHost(): LaunchdHost {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: os.homedir(),
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.error) return { status: null, stdout: '', stderr: result.error.message };
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    stopTimeoutMs: 30_000,
  };
}

export interface ServiceSpec {
  label: string;
  plistPath: string;
  logPath: string;
  programArguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  /** AGENTMONITOR_* settings left out of the plist because their names mark a secret. */
  skippedSecrets: string[];
  dbPath: string;
}

// The plist is a plain file under ~/Library, so nothing that names a credential
// goes into it. AGENTMONITOR_WAREHOUSE_DSN can carry a password.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN/;
// Seams for tests, never runtime configuration.
const TEST_ONLY = new Set(['AGENTMONITOR_PORTLESS_CLI']);

function recordedName(name: string): boolean {
  if (name === 'PATH' || name === 'CODEX_HOME') return true;
  return name.startsWith('AGENTMONITOR_') && !name.startsWith('AGENTMONITOR_TEST_') && !TEST_ONLY.has(name);
}

/**
 * What `amon service install` would write, from the CLI that runs it.
 *
 * launchd starts the server without a login shell, so it gets none of the
 * shell's environment. The install records PATH (the Codex quota reader runs
 * `codex app-server`) and the AGENTMONITOR_* settings in effect, except those
 * whose names mark a secret. The server runs the build this CLI belongs to,
 * direct on its port: Portless is a separate, machine-wide proxy.
 */
export function buildServiceSpec(input: {
  host: LaunchdHost;
  nodePath: string;
  entryScript: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): ServiceSpec {
  const entry = fs.realpathSync(input.entryScript);
  if (path.basename(path.dirname(entry)) !== 'dist') {
    throw new CliError(
      `The service runs the built CLI, but this command is running ${entry}. `
      + 'Run `pnpm build`, then `amon service install` (or `node dist/cli.js service install`).',
    );
  }

  const environment: Record<string, string> = {};
  const skippedSecrets: string[] = [];
  for (const name of Object.keys(input.env).sort()) {
    const value = input.env[name];
    if (value === undefined || value === '' || !recordedName(name)) continue;
    if (SECRET_NAME.test(name)) {
      skippedSecrets.push(name);
      continue;
    }
    environment[name] = value;
  }
  // The service's working directory is the install root, not this shell's.
  if (environment.AGENTMONITOR_DB_PATH) {
    environment.AGENTMONITOR_DB_PATH = path.resolve(input.cwd, environment.AGENTMONITOR_DB_PATH);
  }

  return {
    label: SERVICE_LABEL,
    plistPath: plistPath(input.host),
    logPath: path.join(input.host.home, 'Library', 'Logs', 'agentmonitor', 'serve.log'),
    programArguments: [input.nodePath, entry, 'serve', '--no-portless'],
    workingDirectory: path.dirname(path.dirname(entry)),
    environment,
    skippedSecrets,
    dbPath: path.resolve(input.cwd, resolveDbPath(input.env)),
  };
}

function plistPath(host: LaunchdHost): string {
  return path.join(host.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPlist(spec: ServiceSpec): string {
  const strings = (values: string[]) => values.map(value => `    <string>${xml(value)}</string>`).join('\n');
  const environment = Object.entries(spec.environment)
    .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  // KeepAlive restarts a server that crashes, not one that was stopped: a
  // handled SIGTERM exits 0. ThrottleInterval spaces retries while another
  // runtime holds the database.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(spec.programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

interface ServiceState {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  lastExitCode: string | null;
}

function assertSupported(host: LaunchdHost): void {
  if (host.platform !== 'darwin') throw unavailable('`amon service` manages a macOS launchd agent; this is not macOS.');
  // Like the install-database guard in src/db/connection.ts: a test that forgot
  // to substitute the host would install a real login service.
  if (process.env.NODE_TEST_CONTEXT && path.resolve(host.home) === path.resolve(os.homedir())) {
    throw new Error('Refusing to manage the real launchd agent from a test; pass a temporary home.');
  }
}

function domain(host: LaunchdHost): string {
  return `gui/${host.uid}`;
}

function readServiceState(host: LaunchdHost): ServiceState {
  assertSupported(host);
  const result = host.run('launchctl', ['print', `${domain(host)}/${SERVICE_LABEL}`]);
  if (result.status !== 0) return { loaded: false, state: null, pid: null, lastExitCode: null };
  const field = (name: string) => result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim() ?? null;
  const pid = field('pid');
  return {
    loaded: true,
    state: field('state'),
    pid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
    lastExitCode: field('last exit code'),
  };
}

function launchctl(host: LaunchdHost, args: string[]): void {
  const result = host.run('launchctl', args);
  if (result.status !== 0) {
    throw new CliError(`launchctl ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function waitForRelease(host: LaunchdHost, dbPath: string): Promise<void> {
  const deadline = performance.now() + host.stopTimeoutMs;
  while (readRuntimeOwner(dbPath)) {
    if (performance.now() >= deadline) {
      throw new CliError(`The previous server did not release ${dbPath} within ${host.stopTimeoutMs} ms.`);
    }
    await delay(100);
  }
}

/**
 * Write the agent and start it. Refuses while a server the service does not
 * run owns the database: launchd would retry it every ten seconds until that
 * server stopped. Reinstalling stops the service's own server first.
 */
export async function installService(host: LaunchdHost, spec: ServiceSpec): Promise<void> {
  assertSupported(host);
  const current = readServiceState(host);
  const owner = readRuntimeOwner(spec.dbPath);
  if (owner && owner.pid !== current.pid) {
    throw new CliError(
      `AgentMonitor PID ${owner.pid} already serves ${spec.dbPath}. Stop it, then rerun \`amon service install\`.`,
    );
  }

  if (current.loaded) {
    launchctl(host, ['bootout', `${domain(host)}/${SERVICE_LABEL}`]);
    await waitForRelease(host, spec.dbPath);
  }
  fs.mkdirSync(path.dirname(spec.plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
  const staged = `${spec.plistPath}.${process.pid}.tmp`;
  fs.writeFileSync(staged, renderPlist(spec), { mode: 0o644 });
  fs.renameSync(staged, spec.plistPath);
  launchctl(host, ['bootstrap', domain(host), spec.plistPath]);
}

/** Stop the service and remove its agent. Returns whether there was one. Logs are kept. */
export function uninstallService(host: LaunchdHost): boolean {
  assertSupported(host);
  const state = readServiceState(host);
  if (state.loaded) launchctl(host, ['bootout', `${domain(host)}/${SERVICE_LABEL}`]);
  const file = plistPath(host);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return state.loaded || existed;
}

/** Restart the service's server so it loads the build now on disk. */
export function restartService(host: LaunchdHost): void {
  assertSupported(host);
  if (!readServiceState(host).loaded) {
    throw notFound('The AgentMonitor service is not installed. Run `amon service install`.');
  }
  launchctl(host, ['kickstart', '-k', `${domain(host)}/${SERVICE_LABEL}`]);
}

export interface ServiceStatus {
  label: string;
  loaded: boolean;
  state: string | null;
  pid: number | null;
  last_exit_code: string | null;
  plist_path: string;
  installed: boolean;
  program_arguments: string[] | null;
  /** False when the recorded CLI is gone, e.g. the checkout moved. */
  entry_exists: boolean | null;
}

export function serviceStatus(host: LaunchdHost): ServiceStatus {
  const state = readServiceState(host);
  const file = plistPath(host);
  const installed = fs.existsSync(file);
  let programArguments: string[] | null = null;
  if (installed) {
    const converted = host.run('plutil', ['-convert', 'json', '-o', '-', file]);
    if (converted.status === 0) {
      const parsed = JSON.parse(converted.stdout) as { ProgramArguments?: unknown };
      if (Array.isArray(parsed.ProgramArguments)) programArguments = parsed.ProgramArguments.map(String);
    }
  }
  const entry = programArguments?.[1];
  return {
    label: SERVICE_LABEL,
    plist_path: file,
    installed,
    loaded: state.loaded,
    state: state.state,
    pid: state.pid,
    last_exit_code: state.lastExitCode,
    program_arguments: programArguments,
    entry_exists: entry ? fs.existsSync(entry) : null,
  };
}
