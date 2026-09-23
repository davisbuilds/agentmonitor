import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

// Isolate the DB before importing anything that reads config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-origin-guard-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const express = (await import('express')).default;
const { createApp } = await import('../src/app.js');
const { apiErrorHandler } = await import('../src/api/local-origin.js');
const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');

interface Reply { status: number; body: string }

function send(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: urlPath, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; port: number }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

function eventBody(sessionId: string): string {
  return JSON.stringify({ session_id: sessionId, agent_type: 'claude_code', event_type: 'tool_use', tool_name: 'Bash' });
}

function eventsFor(sessionId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

const servers: Server[] = [];
let loopbackPort = 0;
let wildcardPort = 0;

before(async () => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const loopback = await listen(createApp({ bindHost: '127.0.0.1' }));
  const wildcard = await listen(createApp({ bindHost: '0.0.0.0' }));
  servers.push(loopback.server, wildcard.server);
  loopbackPort = loopback.port;
  wildcardPort = wildcard.port;
});

after(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a web page cannot write to the local server', () => {
  test('a cross-origin text/plain POST is refused and writes nothing', async () => {
    // text/plain is CORS-safelisted, so the browser sends this without a
    // preflight; the page never needs to read the response for the write to land.
    const reply = await send(loopbackPort, 'POST', '/api/events', {
      'Content-Type': 'text/plain',
      Origin: 'https://evil.example.com',
    }, eventBody('forged'));
    assert.equal(reply.status, 403);
    assert.equal(eventsFor('forged'), 0);
  });

  test('an opaque "null" origin is refused', async () => {
    // Sandboxed iframes and file:// pages send Origin: null.
    const reply = await send(loopbackPort, 'POST', '/api/otel/v1/logs', {
      'Content-Type': 'text/plain',
      Origin: 'null',
    }, '{}');
    assert.equal(reply.status, 403);
  });

  test('every state-changing method is covered, not just ingest', async () => {
    const reply = await send(loopbackPort, 'DELETE', '/api/v2/insights/1', { Origin: 'https://evil.example.com' });
    assert.equal(reply.status, 403);
  });

  test('a hook or exporter, which sends no Origin, still writes', async () => {
    const reply = await send(loopbackPort, 'POST', '/api/events', { 'Content-Type': 'application/json' }, eventBody('hook'));
    assert.equal(reply.status, 201);
    assert.equal(eventsFor('hook'), 1);
  });

  for (const origin of ['http://127.0.0.1:3141', 'http://localhost:5173', 'https://agentmonitor.localhost', 'http://[::1]:3141']) {
    test(`the app's own origin ${origin} still writes`, async () => {
      const sessionId = `app-${origin}`;
      const reply = await send(loopbackPort, 'POST', '/api/events', {
        'Content-Type': 'application/json',
        Origin: origin,
      }, eventBody(sessionId));
      assert.equal(reply.status, 201);
      assert.equal(eventsFor(sessionId), 1);
    });
  }
});

describe('a loopback-bound server answers only loopback host names', () => {
  test('a rebound foreign Host is refused', async () => {
    // DNS rebinding points evil.example.com at 127.0.0.1: the page is then
    // same-origin with the server and could read it, but the Host header gives it away.
    const reply = await send(loopbackPort, 'GET', '/api/health', { Host: 'evil.example.com:3141' });
    assert.equal(reply.status, 403);
  });

  for (const host of ['127.0.0.1:3141', 'localhost:3141', 'agentmonitor.localhost', '[::1]:3141']) {
    test(`Host ${host} is served`, async () => {
      const reply = await send(loopbackPort, 'GET', '/api/health', { Host: host });
      assert.equal(reply.status, 200);
    });
  }
});

describe('loopback is recognized however it is spelled', () => {
  // Node binds `--host 0:0:0:0:0:0:0:1` to ::1; reading it as an external
  // bind would silently drop the rebinding check.
  for (const bindHost of ['0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '127.1', 'LOCALHOST']) {
    test(`a server bound to ${bindHost} still refuses a rebound Host`, async () => {
      const { server, port } = await listen(createApp({ bindHost }));
      servers.push(server);
      const reply = await send(port, 'GET', '/api/health', { Host: 'evil.example.com:3141' });
      assert.equal(reply.status, 403);
    });
  }

  for (const host of ['[0:0:0:0:0:0:0:1]:3141', '[::ffff:127.0.0.1]:3141', 'localhost.:3141']) {
    test(`Host ${host} is served`, async () => {
      const reply = await send(loopbackPort, 'GET', '/api/health', { Host: host });
      assert.equal(reply.status, 200);
    });
  }
});

describe('a server bound beyond loopback', () => {
  test('serves whatever Host it is reached by', async () => {
    const reply = await send(wildcardPort, 'GET', '/api/health', { Host: '192.168.1.20:3141' });
    assert.equal(reply.status, 200);
  });

  test('accepts writes from the page it serves, and refuses other origins', async () => {
    const own = await send(wildcardPort, 'POST', '/api/events', {
      'Content-Type': 'application/json',
      Host: '192.168.1.20:3141',
      Origin: 'http://192.168.1.20:3141',
    }, eventBody('lan'));
    assert.equal(own.status, 201);

    const foreign = await send(wildcardPort, 'POST', '/api/events', {
      'Content-Type': 'text/plain',
      Host: '192.168.1.20:3141',
      Origin: 'https://evil.example.com',
    }, eventBody('lan-forged'));
    assert.equal(foreign.status, 403);
    assert.equal(eventsFor('lan-forged'), 0);
  });
});

describe('errors do not leak server internals', () => {
  // Beyond the obvious garbage: a numeral too large for any Date, as a string
  // and as a JSON number, must not throw a RangeError either.
  for (const timeUnixNano of ['not-a-number', '9'.repeat(30), 1e30]) {
    test(`a malformed OTLP timestamp ${JSON.stringify(timeUnixNano).slice(0, 16)} is ingested without one, not a 500`, async () => {
      const sessionId = `bad-ts-${String(timeUnixNano).slice(0, 8)}`;
      const payload = {
        resourceLogs: [{
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'claude-code' } },
              { key: 'session.id', value: { stringValue: sessionId } },
            ],
          },
          scopeLogs: [{
            logRecords: [{
              timeUnixNano,
              attributes: [
                { key: 'event.name', value: { stringValue: 'claude_code.tool_result' } },
                { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
              ],
            }],
          }],
        }],
      };
      const reply = await send(loopbackPort, 'POST', '/api/otel/v1/logs', { 'Content-Type': 'application/json' }, JSON.stringify(payload));
      assert.equal(reply.status, 200, reply.body);
      assert.equal(eventsFor(sessionId), 1);
    });
  }

  test('an unhandled error returns a bare 500 with no stack or path', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error(`failed reading ${import.meta.filename}`); });
    app.use(apiErrorHandler);
    const { server, port } = await listen(app as unknown as ReturnType<typeof createApp>);
    servers.push(server);
    const originalError = console.error;
    console.error = () => {};
    try {
      const reply = await send(port, 'GET', '/boom');
      assert.equal(reply.status, 500);
      assert.deepEqual(JSON.parse(reply.body), { error: 'Internal server error' });
    } finally {
      console.error = originalError;
    }
  });

  test('a client error keeps its status and safe message', async () => {
    const reply = await send(loopbackPort, 'POST', '/api/events', { 'Content-Type': 'application/json' }, 'x'.repeat(2 * 1024 * 1024));
    assert.equal(reply.status, 413);
    assert.doesNotMatch(reply.body, /node_modules|\bat \w/);
  });
});
