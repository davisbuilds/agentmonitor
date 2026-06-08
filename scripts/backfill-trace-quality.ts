#!/usr/bin/env tsx
/**
 * Backfill AgentMonitor's local trace-quality projection tables.
 *
 * Usage:
 *   pnpm run trace-quality:backfill
 *   pnpm run trace-quality:backfill -- --source events
 *   pnpm run trace-quality:backfill -- --source sessions --session-id <id>
 *   pnpm run trace-quality:backfill -- --dry-run
 *   pnpm run trace-quality:backfill -- --force
 */

import { closeDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { backfillTraceQuality, type BackfillTraceQualityOptions } from '../src/trace-quality/service.js';

function parseArgs(): BackfillTraceQualityOptions {
  const args = process.argv.slice(2);
  let source: BackfillTraceQualityOptions['source'] = 'all';
  let sessionId: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--':
        break;
      case '--source':
        source = args[++i] as BackfillTraceQualityOptions['source'];
        if (!['events', 'sessions', 'all'].includes(source)) {
          console.error(`Invalid source: ${source}. Must be events, sessions, or all.`);
          process.exit(1);
        }
        break;
      case '--session-id':
        sessionId = args[++i];
        if (!sessionId) {
          console.error('Missing value for --session-id.');
          process.exit(1);
        }
        break;
      case '--from': {
        const raw = args[++i];
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          console.error(`Invalid --from date: ${raw}`);
          process.exit(1);
        }
        from = parsed.toISOString();
        break;
      }
      case '--to': {
        const raw = args[++i];
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          console.error(`Invalid --to date: ${raw}`);
          process.exit(1);
        }
        to = parsed.toISOString();
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--help':
      case '-h':
        console.log(`
AgentMonitor Trace Quality Backfill

Usage: pnpm run trace-quality:backfill -- [options]

Options:
  --source <type>      Source rows to project: events, sessions, all (default: all)
  --session-id <id>    Limit backfill to one AgentMonitor session id
  --from <date>        Only scan source rows at or after this ISO date
  --to <date>          Only scan source rows at or before this ISO date
  --dry-run            Preview projection without writing trace-quality rows
  --force              Rebuild projected rows for the selected source scope
  --help, -h           Show this help message
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}. Use --help for usage.`);
        process.exit(1);
    }
  }

  return { source, sessionId, from, to, dryRun, force };
}

const options = parseArgs();

console.log('AgentMonitor Trace Quality Backfill');
console.log(`  Source:   ${options.source}`);
if (options.sessionId) console.log(`  Session:  ${options.sessionId}`);
if (options.from) console.log(`  From:     ${options.from}`);
if (options.to) console.log(`  To:       ${options.to}`);
if (options.dryRun) console.log('  Mode:     DRY RUN (no database writes)');
if (options.force) console.log('  Force:    rebuilding selected trace-quality rows');
console.log('');

initSchema();

const summary = backfillTraceQuality(options);

console.log(`Results${options.dryRun ? ' (dry run)' : ''}:`);
console.log(`  Sources scanned:       ${summary.sourcesScanned}`);
console.log(`  Traces created:        ${summary.tracesCreated}`);
console.log(`  Traces updated:        ${summary.tracesUpdated}`);
console.log(`  Observations created:  ${summary.observationsCreated}`);
console.log(`  Observations updated:  ${summary.observationsUpdated}`);
console.log(`  Skipped unchanged:     ${summary.skippedUnchanged}`);
if (summary.warnings.length > 0) {
  console.log(`  Warnings:              ${summary.warnings.length}`);
  for (const warning of summary.warnings) {
    console.log(`    - ${warning}`);
  }
}

closeDb();
