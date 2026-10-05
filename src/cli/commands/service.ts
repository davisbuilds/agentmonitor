import { rejectExtraPositionals } from '../args.js';
import { registerCommand } from '../commands.js';
import { CliError } from '../errors.js';
import {
  buildServiceSpec,
  currentLaunchdHost,
  installService,
  restartService,
  serviceStatus,
  uninstallService,
} from '../launchd.js';
import { writeHuman, writeJson, writeStdout } from '../output.js';

const GROUP = 'Runtime Commands';

export function registerServiceCommands(): void {
  registerCommand({
    name: 'service install',
    group: GROUP,
    summary: 'Run `amon serve` as a macOS login service that restarts after a crash',
    usage: 'service install [--json]',
    examples: ['service install', 'service install --json'],
    async handler(ctx, args) {
      rejectExtraPositionals(args, 'amon service install');
      const entryScript = process.argv[1];
      if (!entryScript) throw new CliError('Cannot locate the AgentMonitor CLI entrypoint');
      const host = currentLaunchdHost();
      const spec = buildServiceSpec({ host, nodePath: process.execPath, entryScript, env: process.env, cwd: process.cwd() });
      await installService(host, spec);
      const summary = {
        label: spec.label,
        plist_path: spec.plistPath,
        log_path: spec.logPath,
        program_arguments: spec.programArguments,
        environment: Object.keys(spec.environment),
        skipped_secrets: spec.skippedSecrets,
      };
      if (ctx.global.json) {
        writeJson(ctx, summary);
        return;
      }
      writeHuman(ctx, [
        `Installed ${spec.label}: ${spec.plistPath}`,
        `Runs: ${spec.programArguments.join(' ')}`,
        `Logs: ${spec.logPath}`,
        `Environment: ${summary.environment.join(', ')}`,
        ...(spec.skippedSecrets.length > 0
          ? [`Not recorded (secret): ${spec.skippedSecrets.join(', ')}`]
          : []),
        'After a rebuild, run `amon service restart`.',
      ].join('\n'));
    },
  });

  registerCommand({
    name: 'service restart',
    group: GROUP,
    summary: 'Restart the service so it loads the build on disk',
    usage: 'service restart',
    examples: ['service restart'],
    handler(ctx, args) {
      rejectExtraPositionals(args, 'amon service restart');
      restartService(currentLaunchdHost());
      writeHuman(ctx, 'Restarted the AgentMonitor service.');
    },
  });

  registerCommand({
    name: 'service status',
    group: GROUP,
    summary: 'Show whether the login service is installed and running',
    usage: 'service status [--json]',
    examples: ['service status', 'service status --json'],
    handler(ctx, args) {
      rejectExtraPositionals(args, 'amon service status');
      const status = serviceStatus(currentLaunchdHost());
      if (ctx.global.json) {
        writeJson(ctx, status);
        return;
      }
      if (!status.installed && !status.loaded) {
        writeStdout(ctx, 'The AgentMonitor service is not installed.');
        return;
      }
      writeStdout(ctx, [
        `Service: ${status.label} (${status.loaded ? status.state ?? 'loaded' : 'not loaded'})`,
        `PID: ${status.pid ?? '-'}`,
        `Last exit: ${status.last_exit_code ?? '-'}`,
        `Plist: ${status.plist_path}${status.installed ? '' : ' (missing)'}`,
        ...(status.program_arguments ? [`Runs: ${status.program_arguments.join(' ')}`] : []),
        ...(status.entry_exists === false ? ['Warning: the recorded CLI no longer exists; rerun `amon service install`.'] : []),
      ].join('\n'));
    },
  });

  registerCommand({
    name: 'service uninstall',
    group: GROUP,
    summary: 'Stop the login service and remove it',
    usage: 'service uninstall',
    examples: ['service uninstall'],
    handler(ctx, args) {
      rejectExtraPositionals(args, 'amon service uninstall');
      const removed = uninstallService(currentLaunchdHost());
      writeHuman(ctx, removed ? 'Removed the AgentMonitor service.' : 'The AgentMonitor service was not installed.');
    },
  });
}
