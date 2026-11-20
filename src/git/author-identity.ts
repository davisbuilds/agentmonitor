import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);

export function normalizeAuthorEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function gitAuthorEmails(): Promise<ReadonlySet<string>> {
  if (config.git.authorEmails !== undefined) {
    return new Set(config.git.authorEmails.map(normalizeAuthorEmail));
  }
  try {
    const { stdout } = await run('git', ['config', '--get', 'user.email'], {
      cwd: config.projectsDir,
      timeout: 1_000,
      maxBuffer: 4_096,
    });
    const email = normalizeAuthorEmail(stdout);
    return new Set(email ? [email] : []);
  } catch {
    return new Set();
  }
}
