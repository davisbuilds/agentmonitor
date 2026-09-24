import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildStatus {
  /** False when this process does not run from a built `dist/` (for example `pnpm dev`). */
  tracked: boolean;
  /** True when the build on disk no longer matches the one this process loaded. */
  stale: boolean;
  started: string | null;
  current: string | null;
}

/**
 * A fingerprint of what a server loads once and keeps for its lifetime: the
 * compiled JavaScript and the pricing tables. It hashes content, so rebuilding
 * the same source does not read as a change.
 */
export function buildFingerprint(root: string): string {
  const hash = crypto.createHash('sha256');
  for (const relative of loadedFiles(root)) {
    hash.update(relative).update('\0').update(fs.readFileSync(path.join(root, relative))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function loadedFiles(root: string, dir = ''): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...loadedFiles(root, relative));
    else if (relative.endsWith('.js') || relative.startsWith(path.join('pricing', 'data') + path.sep)) files.push(relative);
  }
  return files.sort();
}

/** The `dist/` directory this code was loaded from, or null when it runs from source. */
export function runningBuildRoot(moduleUrl: string = import.meta.url): string | null {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(dir) === 'dist' ? dir : null;
}

export interface BuildWatch {
  started: string | null;
  status(): BuildStatus;
}

export function createBuildWatch(root: string | null): BuildWatch {
  const started = root ? fingerprintOrNull(root) : null;
  return {
    started,
    status() {
      if (!root || !started) return { tracked: false, stale: false, started: null, current: null };
      // A build in progress can remove files; that is a changed build too.
      const current = fingerprintOrNull(root);
      return { tracked: true, stale: current !== started, started, current };
    },
  };
}

function fingerprintOrNull(root: string): string | null {
  try {
    return buildFingerprint(root);
  } catch {
    return null;
  }
}

let serverWatch: BuildWatch | null = null;

/** Record the build this server process loaded. Call once, at startup. */
export function startServerBuildWatch(root: string | null = runningBuildRoot()): string | null {
  serverWatch = createBuildWatch(root);
  return serverWatch.started;
}

export function serverBuildStatus(): BuildStatus {
  return serverWatch?.status() ?? { tracked: false, stale: false, started: null, current: null };
}
