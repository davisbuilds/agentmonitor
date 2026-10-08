import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const E2E_ROOT = path.join(ROOT, 'e2e');
const SRC_ROOT = path.join(ROOT, 'src');
const ISOLATED_DB = path.join(E2E_ROOT, 'isolated-db.ts');
// Static `from '...'`, side-effect `import '...'` and dynamic `import('...')`.
const RELATIVE_IMPORT = /(?:from\s+|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Resolve a relative specifier the way the TypeScript sources write it (`.js` for `.ts`). */
function resolveImport(fromFile: string, specifier: string): string {
  const target = path.resolve(path.dirname(fromFile), specifier);
  return target.endsWith('.js') ? target.slice(0, -3) + '.ts' : target;
}

/**
 * Whether a spec reaches src/, directly or through other e2e files it imports.
 * isolated-db.ts is not followed: it reaches src/ only to isolate the database.
 */
function reachesSource(spec: string): boolean {
  const seen = new Set<string>();
  const pending = [spec];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file) || file === ISOLATED_DB || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const target = resolveImport(file, match[1]);
      if (target.startsWith(SRC_ROOT + path.sep)) return true;
      if (target.startsWith(E2E_ROOT + path.sep)) pending.push(target);
    }
  }
  return false;
}

// Playwright runs several spec files in one worker, and `config` snapshots the
// database path on first import. A spec that boots the app in-process without
// useIsolatedDb() reads the previous file's database: in CI, with one worker,
// such specs failed their first attempt and passed on a retry in a fresh worker.
// The call must be in the spec itself: a shared module runs once per worker.
test('every e2e spec that boots the app in-process opens its own database', () => {
  // Playwright discovers specs in subdirectories too.
  const specs = (fs.readdirSync(E2E_ROOT, { recursive: true }) as string[])
    .filter(name => name.endsWith('.spec.ts'));
  const inProcess = specs.filter(name => reachesSource(path.join(E2E_ROOT, name)));
  // A floor, so a renamed directory or import style cannot pass with nothing checked.
  assert.ok(inProcess.length >= 8, `expected at least 8 in-process specs, found ${inProcess.length}`);

  const offenders = inProcess.filter(name => {
    const source = fs.readFileSync(path.join(E2E_ROOT, name), 'utf8');
    return !source.includes('useIsolatedDb(') || /AGENTMONITOR_DB_PATH\s*=/.test(source);
  });
  assert.deepEqual(offenders, [], 'call useIsolatedDb() from e2e/isolated-db.ts in the spec instead of setting AGENTMONITOR_DB_PATH');
});
