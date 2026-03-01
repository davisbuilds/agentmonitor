import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_ROOT = path.join(ROOT, 'src');
const SEARCH_ROOTS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'tests'),
  path.join(ROOT, 'scripts'),
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'docs',
  'public',
  'data',
  'src-tauri',
  'rust-backend',
]);

const EXPORT_EXCEPTIONS = new Set<string>([]);

const FILE_EXCEPTIONS = new Set<string>([
  'src/server.ts',
]);

interface ExportInfo {
  name: string;
  isDefaultName: boolean;
}

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    results.push(full);
  }
  return results;
}

function extractExports(content: string): ExportInfo[] {
  const found: ExportInfo[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  const add = (name: string, isDefaultName: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    found.push({ name, isDefaultName });
  };

  const declRe =
    /export\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+(\w+)/g;
  while ((match = declRe.exec(content))) add(match[1], false);

  const defaultRe = /export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+(\w+)/g;
  while ((match = defaultRe.exec(content))) add(match[1], true);

  const braceRe = /export\s*\{([^}]+)\}/g;
  while ((match = braceRe.exec(content))) {
    const items = match[1].split(',');
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const name = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (/^\w+$/.test(name)) add(name, false);
    }
  }

  return found;
}

function extractSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;

  const fromRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  while ((match = fromRe.exec(content))) specifiers.push(match[1]);

  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((match = sideEffectRe.exec(content))) specifiers.push(match[1]);

  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(content))) specifiers.push(match[1]);

  return specifiers;
}

function resolveCandidate(basePath: string, candidates: Set<string>): string | null {
  const ext = path.extname(basePath);
  const tries: string[] = [];

  if (ext) {
    tries.push(basePath);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') {
      const without = basePath.slice(0, -ext.length);
      tries.push(`${without}.ts`, `${without}.tsx`, `${without}.mts`, `${without}.cts`);
    }
  } else {
    tries.push(
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.mts`,
      `${basePath}.cts`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.mts'),
      path.join(basePath, 'index.cts'),
    );
  }

  for (const candidate of tries) {
    const resolved = path.resolve(candidate);
    if (candidates.has(resolved)) return resolved;
  }
  return null;
}

function resolveLocalImport(
  specifier: string,
  fromFile: string,
  candidates: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  return resolveCandidate(base, candidates);
}

const allFiles = SEARCH_ROOTS.flatMap((dir) => walkTsFiles(dir)).sort();
const allFileSet = new Set(allFiles.map((file) => path.resolve(file)));
const sourceFiles = allFiles.filter((file) => file.startsWith(SOURCE_ROOT));
const fileContents = new Map<string, string>(
  allFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]),
);

test('dead code: exported symbols are referenced in at least one other file', () => {
  const unreferenced: Array<{ file: string; name: string }> = [];

  for (const filePath of sourceFiles) {
    const relPath = path.relative(ROOT, filePath);
    const content = fileContents.get(filePath) ?? '';
    const exports = extractExports(content);

    for (const { name } of exports) {
      if (name.length < 4) continue;
      if (EXPORT_EXCEPTIONS.has(`${relPath}::${name}`)) continue;

      const re = new RegExp(`\\b${name}\\b`);
      let referenced = false;

      for (const [otherPath, otherContent] of fileContents) {
        if (otherPath === filePath) continue;
        if (re.test(otherContent)) {
          referenced = true;
          break;
        }
      }

      if (!referenced) {
        unreferenced.push({ file: relPath, name });
      }
    }
  }

  if (unreferenced.length > 0) {
    const report = unreferenced
      .sort((a, b) => a.file.localeCompare(b.file))
      .map(({ file, name }) => `  ${file}::${name}`)
      .join('\n');

    assert.fail(
      `Found ${unreferenced.length} unreferenced export(s).\n` +
        `Either remove dead code or add to EXPORT_EXCEPTIONS:\n${report}`,
    );
  }
});

test('dead code: source files are imported by at least one other file', () => {
  const incoming = new Map<string, number>(sourceFiles.map((file) => [file, 0]));

  for (const fromFile of allFiles) {
    const content = fileContents.get(fromFile) ?? '';
    const specifiers = extractSpecifiers(content);
    for (const specifier of specifiers) {
      const resolved = resolveLocalImport(specifier, fromFile, allFileSet);
      if (!resolved) continue;
      if (resolved === fromFile) continue;
      if (!incoming.has(resolved)) continue;
      incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1);
    }
  }

  const orphaned: string[] = [];
  for (const [filePath, refs] of incoming) {
    const relPath = path.relative(ROOT, filePath);
    if (FILE_EXCEPTIONS.has(relPath)) continue;
    if (refs === 0) orphaned.push(relPath);
  }

  if (orphaned.length > 0) {
    const report = orphaned.sort().map((entry) => `  ${entry}`).join('\n');
    assert.fail(
      `Found ${orphaned.length} orphaned source file(s).\n` +
        `Either remove or add to FILE_EXCEPTIONS:\n${report}`,
    );
  }
});
