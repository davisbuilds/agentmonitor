import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * This repository is public, so tracked files must not carry a real account's
 * home path or address. These are structural checks on shape, not a list of
 * private markers: an exact marker list would itself be a disclosure, so it
 * belongs in a private pre-publication check rather than in public source.
 *
 * Placeholder-looking paths stay allowed — fixtures need somewhere to point.
 */
const ALLOWED_HOME_SEGMENTS = new Set([
  'example', 'someone', 'test', 'testuser', 'user', 'me', 'you', 'parity',
  'runner', 'home', 'ci', 'agent', 'dev', 'alice', 'bob',
]);

// Addresses that are intentionally published: package authorship and commit trailers.
const ALLOWED_EMAILS = new Set([
  'noreply@anthropic.com',
  'git@github.com', // the SSH remote form, not an address
]);

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean);
}

function isProbablyText(file: string): boolean {
  return !/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|db|sqlite)$/i.test(file);
}

function readTracked(): Array<{ file: string; content: string }> {
  return trackedFiles()
    .filter(isProbablyText)
    .filter(file => file !== 'tests/codebase/publication-hygiene.test.ts')
    .map(file => {
      const absolute = path.join(ROOT, file);
      try {
        return { file, content: fs.readFileSync(absolute, 'utf-8') };
      } catch {
        return { file, content: '' };
      }
    });
}

describe('publication hygiene (public repository)', () => {
  test('no tracked file hardcodes a real home directory', () => {
    const offenders: string[] = [];
    for (const { file, content } of readTracked()) {
      for (const match of content.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
        const segment = match[1].toLowerCase();
        if (ALLOWED_HOME_SEGMENTS.has(segment)) continue;
        // A path built from an env var or variable is fine; only literals leak.
        if (segment.startsWith('$') || segment.startsWith('{')) continue;
        // `/home/.claude` and friends are synthetic HOMEs assembled in fixtures,
        // not a real account name.
        if (segment.startsWith('.')) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Replace real home paths with a placeholder (e.g. /Users/example/...):\n${offenders.join('\n')}`,
    );
  });

  test('no tracked file carries an unexpected email address', () => {
    const offenders: string[] = [];
    for (const { file, content } of readTracked()) {
      for (const match of content.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        const address = match[0].toLowerCase();
        if (ALLOWED_EMAILS.has(address)) continue;
        if (address.endsWith('.example') || address.includes('example.com')) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Remove or placeholder these addresses, or allowlist a deliberate one:\n${offenders.join('\n')}`,
    );
  });
});
