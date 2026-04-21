#!/usr/bin/env tsx

import os from 'node:os';
import path from 'node:path';
import { initSchema } from '../src/db/schema.js';
import { getDb, closeDb } from '../src/db/connection.js';
import { syncAllCodexFiles } from '../src/watcher/index.js';

function parseArgs(): { codexHome: string } {
  const args = process.argv.slice(2);
  let codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--codex-home': {
        const value = args[++i];
        if (!value) {
          console.error('Missing value for --codex-home');
          process.exit(1);
        }
        codexHome = path.resolve(process.cwd(), value);
        break;
      }
      case '--help':
      case '-h':
        console.log(`
AgentMonitor Codex Session Reparse

Usage: pnpm reparse:codex-sessions [options]

Options:
  --codex-home <path>  Override Codex home directory (default: ~/.codex or $CODEX_HOME)
  --help, -h           Show this help message
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return { codexHome };
}

const opts = parseArgs();

console.log('AgentMonitor Codex Session Reparse');
console.log(`  Codex home: ${opts.codexHome}`);
console.log('  Mode:       force reparse of all Codex session browser files');
console.log('');

initSchema();

const db = getDb();
const stats = syncAllCodexFiles(db, opts.codexHome, { force: true });

console.log('Results:');
console.log(`  Files discovered: ${stats.total}`);
console.log(`  Reparsed:         ${stats.parsed}`);
console.log(`  Skipped:          ${stats.skipped}`);
console.log(`  Errors:           ${stats.errors}`);

closeDb();
