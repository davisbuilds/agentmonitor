import fs from 'fs';
import path from 'path';

function discoverFilesRecursive(
  rootDir: string,
  predicate: (entry: fs.Dirent, fullPath: string) => boolean,
): string[] {
  const files: string[] = [];

  if (!fs.existsSync(rootDir)) return files;

  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (predicate(entry, fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

export function discoverJsonlFilesRecursive(rootDir: string): string[] {
  return discoverFilesRecursive(rootDir, entry => entry.isFile() && entry.name.endsWith('.jsonl'));
}
