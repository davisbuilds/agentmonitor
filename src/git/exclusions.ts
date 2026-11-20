import path from 'node:path';

/** Match a directory itself or a descendant, with whole path components. */
export function isExcludedGitDirectory(directory: string, excludedDirs: readonly string[]): boolean {
  if (!path.isAbsolute(directory)) return false;
  return excludedDirs.some(root => {
    const relative = path.relative(root, directory);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}
