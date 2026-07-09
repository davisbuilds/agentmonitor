import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import {
  scanSkillCatalogs,
  refreshCatalogSnapshots,
  resolveVersionAt,
  type CatalogSkill,
  type CatalogSnapshot,
} from '../src/skills/catalog.ts';

function makeSkill(dir: string, name: string, frontmatter: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`);
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
}

test('scanSkillCatalogs reads name and version from frontmatter', () => {
  const root = tmpRoot();
  makeSkill(root, 'write-spec', 'name: write-spec\nversion: 1.2.3\nskill-type: workflow');

  const skills = scanSkillCatalogs([root]);

  assert.deepEqual(skills, [{ name: 'write-spec', version: '1.2.3', dir: root }]);
});

test('scanSkillCatalogs retains version-less skills with null version', () => {
  const root = tmpRoot();
  makeSkill(root, 'legacy', 'name: legacy\nskill-type: workflow');

  const skills = scanSkillCatalogs([root]);

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, 'legacy');
  assert.equal(skills[0]?.version, null);
});

test('scanSkillCatalogs ignores a version: line outside the frontmatter block', () => {
  const root = tmpRoot();
  const skillDir = path.join(root, 'bodyver');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: bodyver\n---\n\n# bodyver\n\nversion: 9.9.9 in prose\n',
  );

  const skills = scanSkillCatalogs([root]);

  assert.equal(skills[0]?.version, null);
});

test('scanSkillCatalogs follows a symlinked skill directory', () => {
  const target = tmpRoot();
  makeSkill(target, 'realskill', 'name: realskill\nversion: 2.0.0');

  const root = tmpRoot();
  fs.symlinkSync(path.join(target, 'realskill'), path.join(root, 'realskill'), 'dir');

  const skills = scanSkillCatalogs([root]);

  assert.deepEqual(skills, [{ name: 'realskill', version: '2.0.0', dir: root }]);
});

test('scanSkillCatalogs dedupes by skill name, first catalog dir wins', () => {
  const primary = tmpRoot();
  const secondary = tmpRoot();
  makeSkill(primary, 'shared', 'name: shared\nversion: 1.0.0');
  makeSkill(secondary, 'shared', 'name: shared\nversion: 5.5.5');
  makeSkill(secondary, 'secondary-only', 'name: secondary-only\nversion: 3.0.0');

  const skills = scanSkillCatalogs([primary, secondary]);
  const byName = new Map(skills.map(s => [s.name, s]));

  assert.equal(byName.size, 2);
  assert.equal(byName.get('shared')?.version, '1.0.0');
  assert.equal(byName.get('shared')?.dir, primary);
  assert.equal(byName.get('secondary-only')?.version, '3.0.0');
});

test('scanSkillCatalogs skips entries without a readable SKILL.md and missing dirs', () => {
  const root = tmpRoot();
  makeSkill(root, 'good', 'name: good\nversion: 1.0.0');
  // A directory with no SKILL.md.
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
  // A stray file (not a directory) at the skill level.
  fs.writeFileSync(path.join(root, 'stray.txt'), 'not a skill');

  const skills = scanSkillCatalogs([root, path.join(root, 'does-not-exist')]);

  assert.deepEqual(
    skills.map(s => s.name),
    ['good'],
  );
});

test('scanSkillCatalogs handles quoted version values', () => {
  const root = tmpRoot();
  makeSkill(root, 'quoted', "name: quoted\nversion: '4.1.0'");

  const skills = scanSkillCatalogs([root]);

  assert.equal(skills[0]?.version, '4.1.0');
});

// --- Snapshot persistence (DB-backed) ---

let db: Database;
let closeDb: () => void;

function skill(name: string, version: string | null): CatalogSkill {
  return { name, version, dir: '/catalog' };
}

function loadSnapshots(name: string): CatalogSnapshot[] {
  return db
    .prepare(
      `SELECT name, version, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
       FROM skill_catalog_snapshots WHERE name = ? ORDER BY first_seen_at`,
    )
    .all(name) as CatalogSnapshot[];
}

before(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snapshots-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema();
  db = dbModule.getDb();
  closeDb = dbModule.closeDb;
});

after(() => {
  closeDb?.();
});

test('refreshCatalogSnapshots inserts a fresh (name, version) pair', () => {
  db.exec('DELETE FROM skill_catalog_snapshots');
  refreshCatalogSnapshots(db, [skill('alpha', '1.0.0')], '2026-01-01T00:00:00Z');

  const rows = loadSnapshots('alpha');
  assert.deepEqual(rows, [
    { name: 'alpha', version: '1.0.0', firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z' },
  ]);
});

test('refreshCatalogSnapshots bumps last_seen_at without moving first_seen_at', () => {
  db.exec('DELETE FROM skill_catalog_snapshots');
  refreshCatalogSnapshots(db, [skill('alpha', '1.0.0')], '2026-01-01T00:00:00Z');
  refreshCatalogSnapshots(db, [skill('alpha', '1.0.0')], '2026-01-05T00:00:00Z');

  const rows = loadSnapshots('alpha');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.firstSeenAt, '2026-01-01T00:00:00Z');
  assert.equal(rows[0]?.lastSeenAt, '2026-01-05T00:00:00Z');
});

test('refreshCatalogSnapshots keeps a single row for a version-less skill across refreshes', () => {
  db.exec('DELETE FROM skill_catalog_snapshots');
  refreshCatalogSnapshots(db, [skill('legacy', null)], '2026-01-01T00:00:00Z');
  refreshCatalogSnapshots(db, [skill('legacy', null)], '2026-01-02T00:00:00Z');

  const rows = loadSnapshots('legacy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.version, null);
  assert.equal(rows[0]?.lastSeenAt, '2026-01-02T00:00:00Z');
});

test('refreshCatalogSnapshots records a version bump as a distinct row', () => {
  db.exec('DELETE FROM skill_catalog_snapshots');
  refreshCatalogSnapshots(db, [skill('beta', '1.0.0')], '2026-02-01T00:00:00Z');
  refreshCatalogSnapshots(db, [skill('beta', '1.0.0')], '2026-02-10T00:00:00Z');
  refreshCatalogSnapshots(db, [skill('beta', '2.0.0')], '2026-03-01T00:00:00Z');

  const rows = loadSnapshots('beta');
  assert.deepEqual(rows, [
    { name: 'beta', version: '1.0.0', firstSeenAt: '2026-02-01T00:00:00Z', lastSeenAt: '2026-02-10T00:00:00Z' },
    { name: 'beta', version: '2.0.0', firstSeenAt: '2026-03-01T00:00:00Z', lastSeenAt: '2026-03-01T00:00:00Z' },
  ]);
});

test('resolveVersionAt returns the version whose window covers the timestamp', () => {
  const snapshots: CatalogSnapshot[] = [
    { name: 'beta', version: '1.0.0', firstSeenAt: '2026-02-01T00:00:00Z', lastSeenAt: '2026-02-10T00:00:00Z' },
    { name: 'beta', version: '2.0.0', firstSeenAt: '2026-03-01T00:00:00Z', lastSeenAt: '2026-03-20T00:00:00Z' },
  ];

  assert.deepEqual(resolveVersionAt(snapshots, 'beta', '2026-02-05T00:00:00Z'), {
    version: '1.0.0',
    approximate: false,
  });
  assert.deepEqual(resolveVersionAt(snapshots, 'beta', '2026-03-10T00:00:00Z'), {
    version: '2.0.0',
    approximate: false,
  });
});

test('resolveVersionAt falls back to the earliest version (approximate) before history', () => {
  const snapshots: CatalogSnapshot[] = [
    { name: 'beta', version: '1.0.0', firstSeenAt: '2026-02-01T00:00:00Z', lastSeenAt: '2026-02-10T00:00:00Z' },
    { name: 'beta', version: '2.0.0', firstSeenAt: '2026-03-01T00:00:00Z', lastSeenAt: '2026-03-20T00:00:00Z' },
  ];

  assert.deepEqual(resolveVersionAt(snapshots, 'beta', '2026-01-15T00:00:00Z'), {
    version: '1.0.0',
    approximate: true,
  });
});

test('resolveVersionAt returns null for an unknown skill', () => {
  const snapshots: CatalogSnapshot[] = [
    { name: 'beta', version: '1.0.0', firstSeenAt: '2026-02-01T00:00:00Z', lastSeenAt: '2026-02-10T00:00:00Z' },
  ];

  assert.deepEqual(resolveVersionAt(snapshots, 'ghost', '2026-02-05T00:00:00Z'), {
    version: null,
    approximate: false,
  });
});
