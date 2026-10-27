import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('compressed bodies with trailing bytes cannot terminate the application', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-compressed-body-'));
  try {
    // An uncaught decoder error must kill only this disposable process. Exercise
    // createApp's JSON and both raw-text middleware paths, with no live database.
    const script = `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import { once } from 'node:events';
      import { setTimeout as delay } from 'node:timers/promises';
      import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
      import { createApp } from './src/app.ts';
      const app = createApp();
      for (const route of ['/__body_probe', '/api/events/__body_probe', '/api/otel/__body_probe']) {
        app.post(route, (req, res) => res.json({ body: req.body }));
      }
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      async function send(route, encoding, compressed, trailing) {
        const body = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding,
              'Content-Length': compressed.length + trailing.length } }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
          });
          req.on('error', reject);
          req.write(compressed);
          // Deliver bytes after a complete compressed frame, when decoding may
          // already have finished and raw-body has removed its error listener.
          setTimeout(() => req.end(trailing), 25);
        });
        await delay(50);
        return body;
      }
      try {
        for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
          for (const route of ['/__body_probe', '/api/events/__body_probe', '/api/otel/__body_probe']) {
            const compressed = compress(Buffer.from('{"probe":true}'));
            const valid = await send(route, encoding, compressed, Buffer.alloc(0));
            assert.equal(valid.status, 200, route + ' ' + encoding);
            assert.deepEqual(JSON.parse(valid.data).body,
              route === '/__body_probe' ? { probe: true } : '{"probe":true}');
            // The zero byte ends the decoder's accepted frame; the large later
            // chunk then reaches a finished stream (the upstream regression).
            const malformed = await send(route, encoding,
              Buffer.concat([compressed, Buffer.from([0])]), Buffer.alloc(100 * 1024, 0x58));
            assert.ok([200, 400].includes(malformed.status), JSON.stringify(malformed));
            const followup = await send(route, encoding, compressed, Buffer.alloc(0));
            assert.equal(followup.status, 200, 'server must remain available');
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, AGENTMONITOR_DB_PATH: path.join(scratch, 'scratch.db'), NODE_ENV: 'test' },
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
