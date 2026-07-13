#!/usr/bin/env node
/**
 * Fails the build if the pricing tables shipped in dist/ have drifted from src/.
 *
 * This exists because they silently did, for five months. The build used
 * `cp -r src/pricing/data dist/pricing/data`, which creates the directory on the
 * first run but on every run after — the destination now existing — copies the
 * directory *into* it as dist/pricing/data/data/, leaving the JSON the runtime
 * actually reads frozen at whatever the first build produced.
 *
 * Nothing failed. `tsc` was happy, tests were happy (they import from src/), and
 * the dev server was happy (tsx, also src/). Only the built server — the one
 * `amon serve` runs — was affected, and its symptom was a model resolving to no
 * price, which the pricing engine reports as a cost of $0 rather than an error.
 * Every Claude event ingested after the tables last changed was recorded as free.
 *
 * Comparing parsed JSON rather than bytes so formatting-only changes don't fail.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src/pricing/data';
const DIST = 'dist/pricing/data';
const problems = [];

if (!existsSync(DIST)) {
  problems.push(`${DIST} does not exist — the build did not copy the pricing tables.`);
} else {
  // The signature of the cp -r bug: the tables nested one level deeper.
  if (existsSync(join(DIST, 'data'))) {
    problems.push(`${DIST}/data/ exists — the pricing tables were copied into the directory instead of over it, so the runtime is reading a stale copy.`);
  }

  const srcFiles = readdirSync(SRC).filter(f => f.endsWith('.json')).sort();
  const distFiles = readdirSync(DIST).filter(f => f.endsWith('.json')).sort();

  for (const missing of srcFiles.filter(f => !distFiles.includes(f))) {
    problems.push(`${missing} is in ${SRC} but not ${DIST}.`);
  }

  for (const file of srcFiles.filter(f => distFiles.includes(f))) {
    const src = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
    const dist = JSON.parse(readFileSync(join(DIST, file), 'utf8'));
    if (JSON.stringify(src) !== JSON.stringify(dist)) {
      const srcModels = Object.keys(src.models ?? {});
      const distModels = new Set(Object.keys(dist.models ?? {}));
      const dropped = srcModels.filter(m => !distModels.has(m));
      problems.push(
        `${file} differs between ${SRC} and ${DIST}`
        + (dropped.length ? ` — missing from the build: ${dropped.join(', ')}` : ' (same models, different rates)')
        + '. The built server would price these at $0.',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\nPricing tables in dist/ do not match src/:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nA model with no price is billed as $0, not as an error, so this fails silently at runtime.\n');
  process.exit(1);
}

console.log('pricing tables: dist matches src');
