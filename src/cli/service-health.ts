import http from 'node:http';

export interface ServiceHealth {
  /** Whether the server answered `/api/health` in time. */
  responding: boolean;
  /** What happened, for the operator: the status it answered, or why it did not. */
  detail: string;
}

const SERVICE_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Ask a running server whether it answers. launchd reports a process that is
 * alive, which a server frozen in a blocking call still is; only a request
 * shows whether it serves.
 */
export function probeServiceHealth(
  host: string,
  port: number,
  timeoutMs: number = SERVICE_HEALTH_TIMEOUT_MS,
): Promise<ServiceHealth> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (health: ServiceHealth) => {
      if (settled) return;
      settled = true;
      resolve(health);
    };
    const request = http.get({ host, port, path: '/api/health', timeout: timeoutMs }, response => {
      response.resume();
      finish(response.statusCode === 200
        ? { responding: true, detail: 'answered /api/health' }
        : { responding: false, detail: `answered /api/health with HTTP ${response.statusCode}` });
    });
    request.on('timeout', () => {
      finish({ responding: false, detail: `did not answer /api/health within ${timeoutMs / 1000}s` });
      request.destroy();
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({ responding: false, detail: error.code === 'ECONNREFUSED' ? `nothing listens on ${host}:${port}` : `request failed: ${error.message}` });
    });
  });
}
