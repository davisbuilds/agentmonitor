import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Analytics counts sessions. Reading browsing_sessions directly counts a Codex
// session stored under both its rollout basename and its native UUID twice, and
// its messages with it, so every Analytics read takes `listed_sessions`.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, 'src/db/v2-queries.ts'), 'utf8');

function analyticsFunctions(): Array<{ name: string; body: string }> {
  const starts = [...source.matchAll(/^export function (getAnalytics\w+)\(/gm)];
  return starts.map(match => {
    const end = source.slice(match.index + 1).search(/^(export )?function /m);
    return { name: match[1], body: source.slice(match.index, end < 0 ? undefined : match.index + 1 + end) };
  });
}

test('no Analytics read counts browsing_sessions directly', () => {
  const functions = analyticsFunctions();
  assert.ok(functions.length >= 8, `found ${functions.length} Analytics reads; the detector lost them`);
  const raw = functions.filter(fn => /\bFROM\s+browsing_sessions\b/.test(fn.body)).map(fn => fn.name);
  assert.deepEqual(raw, [], 'read listed_sessions (with sessionListCte) instead');
});
