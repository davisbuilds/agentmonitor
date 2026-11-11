import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { runningAsLaunchdService } from '../util/service-context.js';
import { syncGitActivity } from './activity.js';
import { syncAuthoredPullRequests, syncSessionPullRequests } from './github.js';

/** The first pass waits for startup's own transcript sync, which fills the session directories it reads. */
const FIRST_PASS_DELAY_MS = 30_000;

let firstPass: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let lastSkipped = 0;

function refreshGitActivity(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = syncGitActivity(getDb(), { skipPrivacyProtected: runningAsLaunchdService() })
    .then(async report => {
      // Said once per change: under the service the same folders are left each pass.
      if (report.skipped_directories !== lastSkipped && report.skipped_directories > 0) {
        console.error(`[git] left ${report.skipped_directories} session director${report.skipped_directories === 1 ? 'y' : 'ies'} unread: privacy-protected under the login service, or too slow to read`);
      }
      lastSkipped = report.skipped_directories;
      if (report.errors > 0) console.error(`[git] ${report.errors} of ${report.repos} repositories could not be read in full`);
      if (!config.git.githubLookups) return;
      // The user's merged pull requests first: those it records with their
      // details, the session lookup then has no need to ask about.
      const authored = await syncAuthoredPullRequests(getDb());
      if (authored.unanswered > 0) console.error(`[git] GitHub's search did not answer for ${authored.unanswered} month(s) of merged pull requests`);
      const pulls = await syncSessionPullRequests(getDb());
      if (pulls.unanswered > 0) console.error(`[git] GitHub did not answer for ${pulls.unanswered} of ${pulls.checked} pull requests`);
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
