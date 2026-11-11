/**
 * The `file_hash` a migration stores, in `watched_files` or `import_state`, to
 * ask the next sync to reparse that file. No real hash is empty, so a sync
 * that compares hashes reparses it. Any shortcut that skips a file without
 * comparing hashes (by mtime or size) must check for the marker first.
 */
export const REPARSE_REQUESTED_HASH = '';

export function reparseRequested(state: { file_hash: string }): boolean {
  return state.file_hash === REPARSE_REQUESTED_HASH;
}
