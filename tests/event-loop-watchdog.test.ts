import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const watchdog = path.resolve('src/event-loop-watchdog.ts');

/** Run a child that starts the watchdog, then blocks its event loop the way `block` says. */
function runBlocked(block: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const script = `
    import { startEventLoopWatchdog } from ${JSON.stringify(watchdog)};
    // The CPU allowance is far below one core's worth of the stall window: on a
    // loaded machine the busy child may get only a small share of a core, and it
    // must still count as working. A waiting child uses almost none.
    startEventLoopWatchdog({ stallMs: 600, maxCpuMs: 20, checkMs: 100 });
    setTimeout(() => { ${block}; process.exit(0); }, 200);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const limit = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the child outlived the test limit')); }, 15_000);
    child.on('exit', (code, signal) => { clearTimeout(limit); resolve({ code, signal, stderr }); });
  });
}

test('a loop stuck waiting, using no CPU, is killed so launchd restarts it', async () => {
  // Atomics.wait blocks the main thread without spending CPU, as open() does
  // while it waits on a privacy prompt.
  const result = await runBlocked('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)');
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.stderr, /\[watchdog\] the event loop has not run for \d+s and used \d+ms of CPU in the last \d+s/);
});

test('a loop busy with work is left to finish', async () => {
  const result = await runBlocked('const end = Date.now() + 1500; while (Date.now() < end) {}');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /watchdog/);
});

test('work done before a hang does not exempt it: CPU counts over the recent window only', async () => {
  // Useful work (well past the CPU allowance), then a wait that never ends.
  const result = await runBlocked('const end = Date.now() + 500; while (Date.now() < end) {} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000)');
  assert.equal(result.signal, 'SIGKILL');
});
