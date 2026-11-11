import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { probeServiceHealth } from '../src/cli/service-health.js';

async function listening(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

test('a server that answers its health check is responding', async () => {
  const server = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); });
  const port = await listening(server);
  try {
    assert.deepEqual(await probeServiceHealth('127.0.0.1', port, 1_000), { responding: true, detail: 'answered /api/health' });
  } finally { server.close(); }
});

test('a server that accepts the connection but never answers is not responding', async () => {
  // What a server frozen in a blocking call looks like from outside.
  const sockets: net.Socket[] = [];
  const server = net.createServer(socket => { sockets.push(socket); });
  const port = await listening(server);
  try {
    const health = await probeServiceHealth('127.0.0.1', port, 300);
    assert.equal(health.responding, false);
    assert.match(health.detail, /did not answer \/api\/health within 0.3s/);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test('nothing listening is not responding, and says so', async () => {
  const server = net.createServer();
  const port = await listening(server);
  server.close();
  await once(server, 'close');
  const health = await probeServiceHealth('127.0.0.1', port, 1_000);
  assert.equal(health.responding, false);
  assert.match(health.detail, /nothing listens on 127.0.0.1:/);
});

test('service status says a live process that does not serve is not responding, and how to recover', async () => {
  const { formatServiceStatus } = await import('../src/cli/commands/service.js');
  const status = {
    label: 'dev.agentmonitor.serve', loaded: true, state: 'running', pid: 19816, last_exit_code: '(never exited)',
    plist_path: '/Users/example/Library/LaunchAgents/dev.agentmonitor.serve.plist', installed: true,
    program_arguments: ['node', '/x/dist/cli.js', 'serve'], entry_exists: true, address: { host: '127.0.0.1', port: 3141 },
  };
  const hung = formatServiceStatus(status, { responding: false, detail: 'did not answer /api/health within 3s' });
  assert.match(hung, /^Service: dev\.agentmonitor\.serve \(not responding\)$/m);
  assert.match(hung, /^Responding: no, did not answer \/api\/health within 3s$/m);
  assert.match(hung, /Restart it with `amon service restart`/);

  const healthy = formatServiceStatus(status, { responding: true, detail: 'answered /api/health' });
  assert.match(healthy, /^Service: dev\.agentmonitor\.serve \(running\)$/m);
  assert.match(healthy, /^Responding: yes/m);
  assert.doesNotMatch(healthy, /Restart it/);
});
