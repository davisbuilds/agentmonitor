import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('an unreadable provider is identified on stderr while other prices remain available', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pricing-load-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  cpSync(new URL('../src/pricing/data/', import.meta.url), data, { recursive: true });
  copyFileSync(new URL('../src/pricing/index.ts', import.meta.url), path.join(root, 'pricing.mts'));
  rmSync(path.join(data, 'claude.json'));
  writeFileSync(path.join(data, 'codex.json'), 'private-table-content');

  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { pricingRegistry } from './pricing.mts';
    console.log(pricingRegistry.lookup('gemini-3.8-flash')?.provider);
  `], { cwd: root, encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'google');
  assert.match(run.stderr, /\[pricing\].*claude\.json/);
  assert.match(run.stderr, /\[pricing\].*codex\.json/);
  assert.doesNotMatch(run.stderr, /private-table-content|gemini\.json|openrouter\.json/);
});
