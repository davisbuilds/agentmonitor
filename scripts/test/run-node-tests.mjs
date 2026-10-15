#!/usr/bin/env node
// Runs `node --import tsx --test <args>` with a private, empty temp directory
// and fails when a test leaves anything in it. Tests create their databases and
// fixture homes under os.tmpdir(); one that forgets to remove them adds a
// directory to the shared temp folder on every run, which nothing ever reports.
// The private directory is removed afterwards whether or not the run passed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Caches the toolchain keeps in os.tmpdir() on purpose. They are linked to the
// shared ones: servers that tests spawn through tsx time out on a cold cache.
const TOOL_CACHES = [`tsx-${os.userInfo().uid}`, 'node-compile-cache'];

const sharedTmp = os.tmpdir();
const privateTmp = fs.mkdtempSync(path.join(sharedTmp, 'agentmonitor-test-tmp-'));
for (const cache of TOOL_CACHES) {
  fs.mkdirSync(path.join(sharedTmp, cache), { recursive: true });
  fs.symlinkSync(path.join(sharedTmp, cache), path.join(privateTmp, cache), 'dir');
}
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp },
});

const forward = signal => child.kill(signal);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);

child.on('exit', code => {
  const leftovers = fs.readdirSync(privateTmp).filter(entry => !TOOL_CACHES.includes(entry));
  // rmSync removes the cache links themselves, not the shared caches they point to.
  fs.rmSync(privateTmp, { recursive: true, force: true });
  if (leftovers.length > 0) {
    console.error(`\n✖ Tests left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} in the temp directory:`);
    for (const entry of leftovers.sort()) console.error(`  ${entry}`);
    console.error('Remove what a test creates under os.tmpdir() in an after() or after-each hook.');
  }
  // A child killed by a signal has a null code: report it as a failure.
  process.exit(code !== 0 ? code ?? 1 : leftovers.length > 0 ? 1 : 0);
});
