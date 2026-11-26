#!/usr/bin/env node
// WHY: A per-run temp directory makes leaked test fixtures detectable without scanning another
// process's files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHY: Child servers can time out while the transpiler warms an empty cache.
const TOOL_CACHES = [`tsx-${os.userInfo().uid}`, 'node-compile-cache'];

// WHY: Nested invocations need the whole suite, even if their parent is running a CI shard.
const { AGENTMONITOR_TEST_SHARD: shard, AGENTMONITOR_TEST_CONCURRENCY: concurrency, ...testEnv } = process.env;
const testFlags = [];
if (shard !== undefined) {
  const [index, total] = shard.split('/').map(Number);
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard) || index > total) {
    console.error(`AGENTMONITOR_TEST_SHARD must be INDEX/TOTAL with 1 <= INDEX <= TOTAL, got ${JSON.stringify(shard)}`);
    process.exit(2);
  }
  testFlags.push(`--test-shard=${shard}`);
}
if (concurrency !== undefined) {
  if (!/^[1-9]\d*$/.test(concurrency)) {
    console.error(`AGENTMONITOR_TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(concurrency)}`);
    process.exit(2);
  }
  testFlags.push(`--test-concurrency=${concurrency}`);
}

const sharedTmp = os.tmpdir();
const privateTmp = fs.mkdtempSync(path.join(sharedTmp, 'agentmonitor-test-tmp-'));
for (const cache of TOOL_CACHES) {
  fs.mkdirSync(path.join(sharedTmp, cache), { recursive: true });
  fs.symlinkSync(path.join(sharedTmp, cache), path.join(privateTmp, cache), 'dir');
}
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testFlags, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // WHY: A test event spooled under the normal path would later be ingested by the running server.
  env: {
    ...testEnv, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp, AGENTMONITOR_GITHUB_LOOKUPS: '0',
    AGENTMONITOR_HOOK_SPOOL_DIR: path.join(privateTmp, 'hook-spool'),
  },
});

const forward = signal => child.kill(signal);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);

child.on('exit', code => {
  const leftovers = fs.readdirSync(privateTmp).filter(entry => !TOOL_CACHES.includes(entry));
  fs.rmSync(privateTmp, { recursive: true, force: true });
  if (leftovers.length > 0) {
    console.error(`\n✖ Tests left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} in the temp directory:`);
    for (const entry of leftovers.sort()) console.error(`  ${entry}`);
    console.error('Remove what a test creates under os.tmpdir() in an after() or after-each hook.');
  }
  // WHY: A process killed by a signal has no exit code; CI must still see a failure.
  process.exit(code !== 0 ? code ?? 1 : leftovers.length > 0 ? 1 : 0);
});
