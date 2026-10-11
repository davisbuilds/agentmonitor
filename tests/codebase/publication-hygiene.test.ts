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

// Any `-Users-` not glued to an identifier: after a quote, `/`, `=`, space, or line start.
function encodedHomePaths(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(/(?<![A-Za-z0-9_])-(?:Users|home)-([A-Za-z0-9._]+)/g)) {
    if (ALLOWED_HOME_SEGMENTS.has(match[1].toLowerCase())) continue;
    found.push(match[0]);
  }
  return found;
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

  test('no tracked file hardcodes a real home directory in encoded form', () => {
    // Claude names project folders after the path with `/` turned into `-`, so
    // `/Users/<name>/Dev` becomes `-Users-<name>-Dev` and slips past the check
    // above. Usernames can contain `-`, so only the first segment is knowable;
    // fixtures must start the account part with a placeholder.
    const offenders = readTracked().flatMap(({ file, content }) =>
      encodedHomePaths(content).map(found => `${file}: ${found}`));
    assert.deepEqual(
      offenders,
      [],
      `Replace encoded home paths with a placeholder (e.g. -Users-example-Dev):\n${offenders.join('\n')}`,
    );
  });

  test('the encoded-path detector sees every delimiter and ignores placeholders', () => {
    // A detector that misses a form reports the same clean result as a clean tree.
    const positives = [
      "path.join(dir, 'projects', '-Users-realname-Dev')",
      'CLAUDE_PROJECT=-Users-realname-Dev',
      'key: -home-realname-work',
      '/projects/-Users-realname-Dev/session.jsonl',
    ];
    for (const line of positives) assert.equal(encodedHomePaths(line).length, 1, line);
    const negatives = ["'-Users-example-Dev'", '/projects/-Users-test-user-Dev', 'foo-Users-realname'];
    for (const line of negatives) assert.deepEqual(encodedHomePaths(line), [], line);
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
