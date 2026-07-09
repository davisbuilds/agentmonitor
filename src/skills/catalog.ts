import fs from 'node:fs';
import path from 'node:path';

export interface CatalogSkill {
  name: string;
  version: string | null;
  /** The catalog directory this skill was resolved from (not the skill dir). */
  dir: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const VERSION_LINE_RE = /^version:\s*(.+?)\s*$/m;

function extractVersion(skillMd: string): string | null {
  const frontmatter = FRONTMATTER_RE.exec(skillMd);
  if (!frontmatter) return null;

  const match = VERSION_LINE_RE.exec(frontmatter[1]);
  if (!match) return null;

  return match[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function readSkill(catalogDir: string, entryName: string): CatalogSkill | null {
  const skillMdPath = path.join(catalogDir, entryName, 'SKILL.md');
  let content: string;
  try {
    // readFileSync follows symlinks, so symlinked skill dirs resolve transparently.
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return null;
  }

  return { name: entryName, version: extractVersion(content), dir: catalogDir };
}

/**
 * Enumerate installed skills across the given catalog directories, reading each
 * skill's declared version from its SKILL.md frontmatter. Skills are deduped by
 * name with earlier catalog dirs winning; unreadable entries and missing
 * directories are skipped rather than throwing.
 */
export function scanSkillCatalogs(dirs: string[]): CatalogSkill[] {
  const skills: CatalogSkill[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const entryName of entries) {
      if (seen.has(entryName)) continue;
      const skill = readSkill(dir, entryName);
      if (!skill) continue;
      seen.add(entryName);
      skills.push(skill);
    }
  }

  return skills;
}
