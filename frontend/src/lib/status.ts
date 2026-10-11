const QUIET_STATUSES = new Set(['success', 'completed', 'ok']);

/** Whether a status says something: the routine success states are left unsaid. */
export function isNotableStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim() !== '' && !QUIET_STATUSES.has(status.trim().toLowerCase());
}
