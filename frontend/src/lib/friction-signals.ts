import type { FrictionSignal } from './api/client';

/** A signal's chip text: what happened, and how often. */
export function frictionLabel(signal: FrictionSignal): string {
  if (signal.kind === 'failure_streak') return `${signal.count} failures in a row`;
  return signal.count === 1 ? 'Interrupted' : `Interrupted ${signal.count}×`;
}

/** What the chip opens, for its accessible name and tooltip. */
export function frictionDescription(signal: FrictionSignal): string {
  if (signal.kind === 'failure_streak') {
    const where = signal.ordinal === null ? 'Opens the session.' : `Opens at message ${signal.ordinal}.`;
    return `Tool calls failed ${signal.count} times in a row, the longest run in the session. ${where}`;
  }
  const times = signal.count === 1 ? 'once' : `${signal.count} times`;
  const where = signal.ordinal === null ? 'Opens the session.' : `Opens at message ${signal.ordinal}, the first time.`;
  return `You stopped the agent ${times}. ${where}`;
}
