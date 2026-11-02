import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { syncGitActivity } from './activity.js';

/** The first pass waits for startup's own transcript sync, which fills the session directories it reads. */
const FIRST_PASS_DELAY_MS = 30_000;

let firstPass: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function refreshGitActivity(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = syncGitActivity(getDb())
    .then(report => {
      if (report.errors > 0) console.error(`[git] ${report.errors} of ${report.repos} repositories could not be read`);
    })
    .catch(err => console.error('[git] Failed to read git activity:', err))
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function startGitActivityPolling(): void {
  if (timer || config.git.pollIntervalMs <= 0) return;
  firstPass = setTimeout(() => { void refreshGitActivity(); }, FIRST_PASS_DELAY_MS);
  timer = setInterval(() => { void refreshGitActivity(); }, config.git.pollIntervalMs);
}

export async function stopGitActivityPolling(): Promise<void> {
  if (firstPass) clearTimeout(firstPass);
  if (timer) clearInterval(timer);
  firstPass = null;
  timer = null;
  await inFlight;
}
