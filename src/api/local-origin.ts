import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Hooks, OTLP exporters, and the CLI send no Origin; only browsers do. So the
// question for any Origin-bearing write is whether the page is the app itself.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Canonical hostname for a bind address, Host value, or URL hostname. The
 * WHATWG parser normalizes every IP spelling (`127.1`, `0:0:0:0:0:0:0:1`,
 * `::ffff:127.0.0.1`), so the loopback test sees one form for each address.
 */
function canonicalHostname(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, '');
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}`).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** Loopback addresses and `localhost` names, which only this machine can reach. */
function isLocalHostname(hostname: string): boolean {
  const name = canonicalHostname(hostname);
  if (name === null) return false;
  return name === 'localhost'
    || name.endsWith('.localhost')
    || /^127(\.\d{1,3}){3}$/.test(name)
    || name === '[::1]'
    // IPv4-mapped 127.0.0.0/8, which the parser writes in hex (::ffff:7f00:1).
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(name);
}

/** The hostname part of a Host header value, which may carry a port or IPv6 brackets. */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function refuse(res: Response, reason: string): void {
  res.status(403).json({ error: 'forbidden', reason });
}

/**
 * Reject requests a web page could forge against the local server.
 *
 * - Writes carrying a foreign Origin are refused. `text/plain` bodies are
 *   CORS-safelisted, so a page can POST them blind; the write lands whether or
 *   not the page can read the reply.
 * - A loopback-bound server answers only loopback host names, which defeats
 *   DNS rebinding (a foreign name resolved to 127.0.0.1 still sends its own
 *   Host). A server deliberately bound beyond loopback is reached by names we
 *   cannot know, so it skips this check and relies on the Origin rule.
 */
export function localOriginGuard({ bindHost }: { bindHost: string }): RequestHandler {
  const loopbackBound = isLocalHostname(bindHost);
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (loopbackBound && host && !isLocalHostname(hostnameOf(host))) {
      refuse(res, 'host');
      return;
    }

    const origin = req.headers.origin;
    if (origin === undefined || SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      refuse(res, 'origin'); // includes the opaque "null" origin
      return;
    }
    // The app's own page, whether served directly, through Portless, or by the
    // Vite dev server, has a local origin; beyond loopback it matches the Host.
    if (isLocalHostname(originUrl.hostname) || originUrl.host === host) {
      next();
      return;
    }
    refuse(res, 'origin');
  };
}

function statusOf(err: unknown): number {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * Answer an unhandled error without leaking a stack trace or server paths,
 * which Express's default handler prints outside production.
 */
export function apiErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = statusOf(err);
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.path} failed:`, err);
    res.status(status).json({ error: 'Internal server error' });
    return;
  }
  // Client errors from body-parser and friends mark safe messages `expose`.
  const expose = (err as { expose?: unknown }).expose === true && err instanceof Error;
  res.status(status).json({ error: expose ? (err as Error).message : 'Request failed' });
}
