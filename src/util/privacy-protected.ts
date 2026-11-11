import os from 'node:os';
import path from 'node:path';

// Folders macOS guards with a privacy (TCC) prompt, or serves from iCloud or
// another file provider. A process with no one to answer the prompt, such as
// the launchd service, waits in open() for as long as the prompt stands, and a
// synchronous read there freezes the whole server.
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
  // Removable and network volumes have prompts of their own.
  if (within('/Volumes')) return true;
  return PROTECTED_IN_HOME.some(folder => within(path.join(home, folder)));
}
