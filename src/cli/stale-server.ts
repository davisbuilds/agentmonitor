import { buildFingerprint, runningBuildRoot } from '../build-fingerprint.js';
import { resolveDbPath } from '../db-path.js';
import { readRuntimeOwner } from '../runtime-ownership.js';
import { type CliContext, writeStderr } from './output.js';

/**
 * A warning for a one-shot command whose build differs from the server that
 * owns the same database, or null. The server keeps the code it started with,
 * so a command and the server can disagree about how the same rows are written.
 */
export function staleServerWarning(
  owner: { pid: number; build: string | null } | null,
  mine: string | null,
): string | null {
  if (!owner?.build || !mine || owner.build === mine) return null;
  return `Warning: the AgentMonitor server (PID ${owner.pid}) on this database is running a different build `
    + `(${owner.build}) than this command (${mine}). It keeps the code it started with, so it can write rows `
    + 'the old way while this command writes them the new way. Restart `amon serve` to load this build.';
}

/** Warn on stderr when the server on this command's database runs another build. */
export function warnIfServerBuildDiffers(ctx: CliContext): void {
  const root = runningBuildRoot();
  if (!root) return;
  let mine: string;
  try {
    mine = buildFingerprint(root);
  } catch {
    return;
  }
  const warning = staleServerWarning(readRuntimeOwner(resolveDbPath(process.env)), mine);
  if (warning) writeStderr(ctx, warning);
}
