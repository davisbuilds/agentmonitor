import type { GlobalOptions } from './args.js';
import type { CliError } from './errors.js';
import { invalidUsage } from './errors.js';
import { commandHelp, groupHelp } from './help.js';
import type { CliContext } from './output.js';
import { writeStdout } from './output.js';
import { warnIfServerBuildDiffers } from './stale-server.js';

export type CommandHandler = (ctx: CliContext, args: string[]) => Promise<void> | void;

export interface Command {
  name: string;
  group: string;
  summary: string;
  usage?: string;
  examples?: string[];
  handler: CommandHandler;
}

const commands: Command[] = [];

export function registerCommand(command: Command): void {
  commands.push(command);
}

export function listCommands(): Command[] {
  return [...commands];
}

function findCommand(args: string[]): { command: Command; rest: string[] } | null {
  for (let size = Math.min(3, args.length); size >= 1; size -= 1) {
    const candidate = args.slice(0, size).join(' ');
    const command = commands.find(item => item.name === candidate);
    if (command) return { command, rest: args.slice(size) };
  }
  return null;
}

interface CommandGroup {
  prefix: string;
  members: Command[];
  /** The words after the group prefix, before the first flag. */
  extra: string[];
}

/**
 * The longest leading run of words in `args` that names a command group, such
 * as `service` for `service install` and `service status`.
 */
function findGroup(args: string[]): CommandGroup | null {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    words.push(arg);
  }
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    const prefix = words.slice(0, size).join(' ');
    const members = commands.filter(item => item.name.startsWith(`${prefix} `));
    if (members.length > 0) return { prefix, members, extra: words.slice(size) };
  }
  return null;
}

function unknownCommand(commandName: string, args: string[]): CliError {
  const group = findGroup(args);
  if (!group) {
    const attempted = args[0] ?? '';
    return invalidUsage(attempted ? `Unknown command: ${attempted}` : 'Missing command');
  }
  const subcommands = group.members.map(item => item.name.slice(group.prefix.length + 1)).join(', ');
  if (group.extra.length === 0) {
    return invalidUsage(
      `${commandName} ${group.prefix} needs a subcommand: ${subcommands}. `
        + `Run \`${commandName} ${group.prefix} --help\` for details.`,
    );
  }
  return invalidUsage(
    `Unknown command: ${group.prefix} ${group.extra[0]}. `
      + `${commandName} ${group.prefix} subcommands: ${subcommands}.`,
  );
}

/** Help text for a command or a command group; throws for anything else. */
export function helpFor(commandName: string, args: string[]): string {
  const found = findCommand(args);
  if (found) {
    return commandHelp(commandName, found.command.usage ?? found.command.name, found.command.summary, found.command.examples);
  }
  const group = findGroup(args);
  if (group && group.extra.length === 0) return groupHelp(commandName, group.prefix, group.members);
  throw unknownCommand(commandName, args);
}

function applyGlobalEnv(global: GlobalOptions): void {
  if (global.dbPath) process.env.AGENTMONITOR_DB_PATH = global.dbPath;
}

export async function dispatchCommand(ctx: CliContext, args: string[]): Promise<void> {
  if (ctx.global.help) {
    writeStdout(ctx, helpFor(ctx.commandName, args));
    return;
  }
  const found = findCommand(args);
  if (!found) throw unknownCommand(ctx.commandName, args);
  applyGlobalEnv(ctx.global);
  // A one-shot command next to a server on another build is how old code kept
  // writing rows after a fix shipped. `serve` is that server, so it is exempt.
  if (found.command.name !== 'serve') warnIfServerBuildDiffers(ctx);
  await found.command.handler(ctx, found.rest);
}
