import type { StorageReport } from '../../db/storage.js';
import { parseOptionSet, rejectExtraPositionals } from '../args.js';
import { registerCommand } from '../commands.js';
import { CliError, invalidUsage, messageForError } from '../errors.js';
import { writeHuman, writeJson } from '../output.js';

export function registerDatabaseCommands(): void {
  registerCommand({
    name: 'database backup',
    group: 'Data Commands',
    summary: 'Create and validate a closed SQLite backup',
    usage: 'database backup --output <absolute-path> [--replace] [--json]',
    examples: [
      'database backup --output /private/path/agentmonitor.db',
      'database backup --output /private/path/agentmonitor.db --replace --json',
    ],
    async handler(ctx, args) {
      const parsed = parseOptionSet(args, new Set(['--output']), new Set(['--replace']));
      rejectExtraPositionals(parsed.positionals, 'amon database backup --output <absolute-path> [--replace]');
      const output = parsed.values.get('--output');
      if (!output) throw invalidUsage('Missing required --output path.');

      const { resolveDbPath } = await import('../../db-path.js');
      const { createValidatedDatabaseBackup, DatabaseBackupPolicyError } = await import('../../db/backup.js');
      try {
        const result = await createValidatedDatabaseBackup({
          source: resolveDbPath(process.env),
          output,
          replace: parsed.flags.has('--replace'),
        });
        if (ctx.global.json) {
          writeJson(ctx, result);
          return;
        }
        writeHuman(
          ctx,
          [
            'Database backup created',
            `  output: ${result.output}`,
            `  bytes: ${result.bytes}`,
            `  journal_mode: ${result.journal_mode}`,
            `  integrity_check: ${result.integrity_check}`,
            `  foreign_key_violations: ${result.foreign_key_violations}`,
            `  replaced: ${result.replaced}`,
          ].join('\n'),
        );
      } catch (error) {
        if (error instanceof DatabaseBackupPolicyError) throw invalidUsage(error.message);
        throw new CliError(`Database backup failed: ${messageForError(error)}`);
      }
    },
  });

  registerCommand({
    name: 'database storage',
    group: 'Data Commands',
    summary: 'Report database, WAL, free-page and search-index sizes',
    usage: 'database storage [--json]',
    examples: ['database storage', 'database storage --json'],
    async handler(ctx, args) {
      const parsed = parseOptionSet(args, new Set(), new Set());
      rejectExtraPositionals(parsed.positionals, 'amon database storage');
      const { resolveDbPath } = await import('../../db-path.js');
      const { default: Database } = await import('better-sqlite3');
      const { readStorageReport } = await import('../../db/storage.js');
      let db;
      try {
        db = new Database(resolveDbPath(process.env), { readonly: true, fileMustExist: true });
      } catch (error) {
        throw new CliError(`Cannot open the database: ${messageForError(error)}`);
      }
      try {
        const report = readStorageReport(db);
        if (ctx.global.json) {
          writeJson(ctx, report);
          return;
        }
        writeHuman(ctx, `${formatStorageReport(report)}\n`);
      } finally {
        db.close();
      }
    },
  });

  registerCommand({
    name: 'database compact',
    group: 'Data Commands',
    summary: 'Back up, then reclaim free pages and dead search-index entries',
    usage: 'database compact --backup <absolute-path> [--json]',
    examples: ['database compact --backup /private/path/before-compact.db'],
    async handler(ctx, args) {
      const parsed = parseOptionSet(args, new Set(['--backup']), new Set());
      rejectExtraPositionals(parsed.positionals, 'amon database compact --backup <absolute-path>');
      const backup = parsed.values.get('--backup');
      if (!backup) throw invalidUsage('Missing required --backup path: compact rewrites the whole database, so it backs it up first.');

      const { resolveDbPath } = await import('../../db-path.js');
      const { compactDatabase, DatabaseCompactPolicyError } = await import('../../db/compact.js');
      const { DatabaseBackupPolicyError } = await import('../../db/backup.js');
      const { RuntimeOwnershipError } = await import('../../runtime-ownership.js');
      try {
        const result = await compactDatabase({ source: resolveDbPath(process.env), backup });
        if (ctx.global.json) {
          writeJson(ctx, result);
          return;
        }
        writeHuman(
          ctx,
          [
            'Database compacted',
            `  backup: ${result.backup}`,
            `  quick_check: ${result.quick_check}`,
            'Before',
            formatStorageReport(result.before, '  '),
            'After',
            formatStorageReport(result.after, '  '),
          ].join('\n') + '\n',
        );
      } catch (error) {
        if (error instanceof DatabaseCompactPolicyError || error instanceof DatabaseBackupPolicyError) {
          throw invalidUsage(error.message);
        }
        if (error instanceof RuntimeOwnershipError) {
          throw new CliError(`${error.message}\nStop the server before compacting: VACUUM needs the database to itself.`);
        }
        throw new CliError(`Database compact failed: ${messageForError(error)}`);
      }
    },
  });
}

// Decimal units, as Finder and `ls -h` report file sizes on macOS.
function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function formatStorageReport(report: StorageReport, indent = ''): string {
  return [
    `${indent}database: ${formatBytes(report.database_bytes)}`,
    `${indent}wal: ${formatBytes(report.wal_bytes)}`,
    `${indent}free pages: ${report.free_pages} (${formatBytes(report.free_bytes)})`,
    `${indent}search index: ${formatBytes(report.search_index_bytes)}`,
  ].join('\n');
}
