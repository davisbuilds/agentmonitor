import os from 'node:os';
import path from 'node:path';

// WHY: A service cannot answer macOS privacy prompts or reliably traverse an unavailable file
// provider.
const PROTECTED_IN_HOME = [
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  path.join('Library', 'Mobile Documents'),
  path.join('Library', 'CloudStorage'),
];

/** Whether reading `target` may wait on a macOS privacy prompt or a file provider. */
export function isPrivacyProtectedPath(target: string, home: string = os.homedir()): boolean {
  const resolved = path.resolve(target);
  const within = (root: string) => resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (within('/Volumes')) return true;
  return PROTECTED_IN_HOME.some(folder => within(path.join(home, folder)));
}
