import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseIntegerOption, parseOptionSet, rejectExtraPositionals } from '../args.js';
import { registerCommand } from '../commands.js';
import { invalidUsage } from '../errors.js';
import { effectiveBaseUrl, fetchJson } from '../http.js';
import { writeHuman, writeJson, writeStdout } from '../output.js';
import type { CliContext } from '../output.js';

function effectiveDbPath(): string {
  return process.env.AGENTMONITOR_DB_PATH || './data/agentmonitor.db';
}

function setServeEnv(ctx: CliContext, args: string[]): { noImport: boolean; noWatch: boolean } {
  const parsed = parseOptionSet(
    args,
    new Set(['--host', '--port']),
    new Set(['--no-browser', '--no-import', '--no-watch']),
  );
  rejectExtraPositionals(parsed.positionals, 'amon serve [--host <host>] [--port <port>]');
  const host = parsed.values.get('--host');
  const port = parsed.values.get('--port');
  if (host) process.env.AGENTMONITOR_HOST = host;
  if (port) {
    const numericPort = parseIntegerOption(port, '--port');
    if (!numericPort || numericPort < 1 || numericPort > 65535) {
      throw invalidUsage(`Invalid --port: ${port}`);
    }
    process.env.AGENTMONITOR_PORT = String(numericPort);
  }
  if (ctx.global.dbPath) process.env.AGENTMONITOR_DB_PATH = ctx.global.dbPath;
  return {
    noImport: parsed.flags.has('--no-import'),
    noWatch: parsed.flags.has('--no-watch'),
  };
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export function registerRuntimeCommands(): void {
  registerCommand({
    name: 'serve',
    group: 'Runtime Commands',
    summary: 'Start the local AgentMonitor server',
    usage: 'serve [--host <host>] [--port <port>] [--no-import] [--no-watch]',
    examples: ['serve', 'serve --port 3999 --no-import --no-watch'],
    async handler(ctx, args) {
      const options = setServeEnv(ctx, args);
      const { installRuntimeSignalHandlers, startAgentMonitorRuntime } = await import('../../runtime.js');
      const runtime = startAgentMonitorRuntime(options);
      installRuntimeSignalHandlers(runtime);
      await new Promise<void>(() => undefined);
    },
  });

  registerCommand({
    name: 'health',
    group: 'Runtime Commands',
    summary: 'Check the HTTP service health endpoint',
    usage: 'health [--url <url>] [--json]',
    examples: ['health', 'health --url http://127.0.0.1:3141 --json'],
    async handler(ctx, args) {
      rejectExtraPositionals(args, 'amon health [--url <url>]');
      const baseUrl = effectiveBaseUrl(ctx.global.url);
      const payload = await fetchJson(`${baseUrl}/api/health`);
      if (ctx.global.json) {
        writeJson(ctx, payload);
      } else {
        writeHuman(ctx, `AgentMonitor is healthy at ${baseUrl}`);
      }
    },
  });

  registerCommand({
    name: 'status',
    group: 'Runtime Commands',
    summary: 'Show local DB and server status',
    usage: 'status [--url <url>] [--json]',
    examples: ['status', 'status --json'],
    async handler(ctx, args) {
      rejectExtraPositionals(args, 'amon status [--url <url>]');
      const baseUrl = effectiveBaseUrl(ctx.global.url);
      const dbPath = path.resolve(process.cwd(), ctx.global.dbPath || effectiveDbPath());
      let server: unknown = null;
      let serverReachable: boolean;
      try {
        server = await fetchJson(`${baseUrl}/api/health`, 1000);
        serverReachable = true;
      } catch {
        serverReachable = false;
      }
      const payload = {
        url: baseUrl,
        db_path: dbPath,
        db_exists: fs.existsSync(dbPath),
        server_reachable: serverReachable,
        server,
      };
      if (ctx.global.json) {
        writeJson(ctx, payload);
        return;
      }
      writeStdout(ctx, [
        `URL: ${payload.url}`,
        `DB: ${payload.db_path} (${payload.db_exists ? 'exists' : 'missing'})`,
        `Server: ${payload.server_reachable ? 'reachable' : 'unavailable'}`,
      ].join('\n'));
    },
  });

  registerCommand({
    name: 'open',
    group: 'Runtime Commands',
    summary: 'Open the Svelte app in the default browser',
    usage: 'open [--url <url>]',
    examples: ['open'],
    handler(ctx, args) {
      rejectExtraPositionals(args, 'amon open [--url <url>]');
      const appUrl = `${effectiveBaseUrl(ctx.global.url)}/app/`;
      openUrl(appUrl);
      writeHuman(ctx, `Opened ${appUrl}`);
    },
  });
}
