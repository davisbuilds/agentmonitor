import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let server: Server;
let baseUrl = '';
let tempDir = '';

function requestRoot(host?: string): Promise<{ location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(baseUrl, { headers: host ? { Host: host } : undefined }, response => {
      response.resume();
      response.once('end', () => resolve({
        location: response.headers.location,
        status: response.statusCode ?? 0,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-app-routing-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('Server failed to start');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the Portless root redirects to the canonical Svelte app', async () => {
  const response = await requestRoot('agentmonitor.localhost');

  assert.equal(response.status, 302);
  assert.equal(response.location, '/app/');
});

test('the direct loopback root retains the legacy compatibility surface', async () => {
  const response = await requestRoot();

  assert.equal(response.status, 200);
});
