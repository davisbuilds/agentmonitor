const QUIET_STATUSES = new Set(['success', 'completed', 'ok']);

/** Whether a status says something: the routine success states are left unsaid. */
export function isNotableStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim() !== '' && !QUIET_STATUSES.has(status.trim().toLowerCase());
}

/**
 * The StatusDot state for a live session status: live and active sessions read
 * as active, idle as idle, and anything else (ended, unknown) as ended.
 */
export function liveDotStatus(status: string | null | undefined): 'active' | 'idle' | 'ended' {
  if (status === 'live' || status === 'active') return 'active';
  return status === 'idle' ? 'idle' : 'ended';
}
