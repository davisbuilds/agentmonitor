#!/usr/bin/env tsx
import { main } from '../src/cli.js';

const result = await main([process.argv[0] ?? 'node', 'amon', 'costs', 'recalc', ...process.argv.slice(2)]);
process.exitCode = result.exitCode;
