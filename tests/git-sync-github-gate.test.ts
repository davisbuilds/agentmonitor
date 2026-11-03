import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-github-gate-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// A `gh` that records each call and answers any search with nothing.
const bin = path.join(tempDir, 'bin');
const calls = path.join(tempDir, 'gh-calls');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$1 $2" >> "${calls}"
echo '{"data":{"search":{"issueCount":0,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}'
`, { mode: 0o755 });

function syncGit(lookups: '0' | '1'): { status: number | null; stdout: string; stderr: string } {
  // tsx run from a tsx child fails silently unless started through a shell.
  const result = spawnSync('/bin/sh', ['-c', 'exec node --import tsx src/cli.ts sync git --json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AGENTMONITOR_DB_PATH: path.join(tempDir, `lookups-${lookups}.db`),
      AGENTMONITOR_GITHUB_LOOKUPS: lookups,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const ghCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);

test('amon sync git asks GitHub nothing with lookups off, and searches merged pull requests with them on', () => {
  const off = syncGit('0');
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(ghCalls(), [], 'no gh process with lookups off');
  assert.equal(JSON.parse(off.stdout).merged_months_read, undefined);

  const on = syncGit('1');
  assert.equal(on.status, 0, on.stderr);
  // Control: the same command does reach gh once allowed, a search per month of the last year.
  assert.ok(ghCalls().length >= 12, `gh was called ${ghCalls().length} times`);
  assert.ok(ghCalls().every(call => call === 'api graphql'));
  assert.ok(JSON.parse(on.stdout).merged_months_read >= 12);
});
