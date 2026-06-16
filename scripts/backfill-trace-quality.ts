#!/usr/bin/env tsx
import { main } from '../src/cli.js';

const result = await main([process.argv[0] ?? 'node', 'amon', 'quality', 'backfill', ...process.argv.slice(2)]);
process.exitCode = result.exitCode;
