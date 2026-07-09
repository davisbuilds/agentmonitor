import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSkillCatalogs } from '../src/skills/catalog.ts';

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
