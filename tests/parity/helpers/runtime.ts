/**
 * Black-box parity test helpers.
 * All requests target AGENTMONITOR_BASE_URL (defaults to http://127.0.0.1:3141).
 */

export const BASE_URL =
  process.env.AGENTMONITOR_BASE_URL ?? 'http://127.0.0.1:3141';

export async function postJson(
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getJson(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

/** Generate a unique session ID to avoid cross-test pollution. */
export function uniqueSession(): string {
  return `parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique event_id for dedup tests. */
export function uniqueEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
