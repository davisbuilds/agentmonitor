import { Worker } from 'node:worker_threads';

export interface EventLoopWatchdogOptions {
  /** How long the event loop may go without a turn before it counts as stalled. */
  stallMs: number;
  /**
   * The most CPU the process may use in the last `stallMs` and still count as
   * hung.
   * Work that blocks the loop (a long synchronous import) burns CPU and is left
   * alone; a loop waiting in a blocking call (a privacy prompt no one answers, a
   * stuck file read) uses next to none.
   */
  maxCpuMs: number;
  /** How often the watchdog looks. */
  checkMs: number;
}

export const SERVICE_WATCHDOG: EventLoopWatchdogOptions = { stallMs: 5 * 60_000, maxCpuMs: 1_000, checkMs: 10_000 };

// Runs on its own thread, so it still runs while the main thread is stuck. It
// writes with fs.writeSync: process.stderr in a worker is relayed through the
// main thread, which is the one not running. SIGKILL ends the process however
// it is stuck, and launchd restarts a job that ends on a signal.
const WATCHDOG_SOURCE = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const { beat, stallMs, maxCpuMs, checkMs } = workerData;
const lastBeat = new Float64Array(beat);
let seenBeat = lastBeat[0];
// Process CPU sampled every check. The first kept sample is the newest one at
// least stallMs old, so the CPU spent across the last stallMs is measurable:
// work done before a hang must not exempt the hang that follows it.
const samples = [];
setInterval(() => {
  const now = Date.now();
  const usage = process.cpuUsage();
  samples.push({ at: now, cpu: usage.user + usage.system });
  while (samples.length > 1 && samples[1].at <= now - stallMs) samples.shift();
  if (lastBeat[0] !== seenBeat) {
    seenBeat = lastBeat[0];
    return;
  }
  const stalledMs = now - seenBeat;
  if (stalledMs < stallMs || now - samples[0].at < stallMs) return;
  const cpuMs = (samples[samples.length - 1].cpu - samples[0].cpu) / 1000;
  if (cpuMs > maxCpuMs) return;
  fs.writeSync(2, '[watchdog] the event loop has not run for ' + Math.round(stalledMs / 1000) + 's and used '
    + Math.round(cpuMs) + 'ms of CPU in the last ' + Math.round(stallMs / 1000) + 's: it is waiting in a blocking call, not working. Exiting so the service restarts.\\n');
  process.kill(process.pid, 'SIGKILL');
}, checkMs);
`;

/**
 * End a process whose event loop is stuck waiting. Returns a stop function. Only
 * the launchd service starts it: there an exit is followed by a restart, and a
 * frozen server would otherwise stay frozen while launchd reports it running.
 */
export function startEventLoopWatchdog(options: EventLoopWatchdogOptions): () => void {
  const beat = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
  const lastBeat = new Float64Array(beat);
  lastBeat[0] = Date.now();
  const heartbeat = setInterval(() => { lastBeat[0] = Date.now(); }, Math.min(1_000, options.checkMs));
  heartbeat.unref();
  // No inherited flags: the source is CommonJS, which a parent's --input-type
  // or loader would otherwise change.
  const worker = new Worker(WATCHDOG_SOURCE, { eval: true, execArgv: [], workerData: { beat, ...options } });
  worker.unref();
  return () => {
    clearInterval(heartbeat);
    void worker.terminate();
  };
}
