#!/usr/bin/env tsx
import { main } from '../src/cli.js';

const result = await main([
  process.argv[0] ?? 'node',
  'amon',
  'sync',
  'sessions',
  '--source',
  'claude',
  '--force',
  ...process.argv.slice(2),
]);
process.exitCode = result.exitCode;
