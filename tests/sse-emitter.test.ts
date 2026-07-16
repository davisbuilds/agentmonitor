import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { broadcaster } from '../src/sse/emitter.js';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> | null = null;
  writableEnded = false;
  destroyed = false;

  constructor(private readonly writeResult = true) {
    super();
  }

  writeHead(_status: number, headers: Record<string, string>): void {
    this.headers = headers;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeResult;
  }

  end(): void {
    this.writableEnded = true;
  }
}

test('broadcaster writes connected events, applies filters, and cleans up on close', () => {
  const codex = new FakeResponse();
  const claude = new FakeResponse();

  assert.equal(broadcaster.addClient(codex as never, { agentType: 'codex' }), true);
  assert.equal(broadcaster.addClient(claude as never, { eventType: 'error' }), true);
  assert.equal(codex.headers?.['Content-Type'], 'text/event-stream');
  assert.equal(broadcaster.clientCount >= 2, true);

  broadcaster.broadcast('event', { agent_type: 'codex', event_type: 'tool_use' });
  broadcaster.broadcast('event', { agent_type: 'claude_code', event_type: 'error' });

  assert.equal(codex.chunks.some(chunk => chunk.includes('"agent_type":"codex"')), true);
  assert.equal(codex.chunks.some(chunk => chunk.includes('"agent_type":"claude_code"')), false);
  assert.equal(claude.chunks.some(chunk => chunk.includes('"event_type":"error"')), true);

  codex.emit('close');
  claude.emit('error', new Error('client closed'));
  assert.equal(codex.writableEnded, true);
  assert.equal(claude.writableEnded, true);
});

test('broadcaster drops clients with repeated backpressure', () => {
  const blocked = new FakeResponse(false);

  assert.equal(broadcaster.addClient(blocked as never), true);
  broadcaster.broadcast('event', { agent_type: 'codex' });
  broadcaster.broadcast('event', { agent_type: 'codex' });

  assert.equal(blocked.writableEnded, true);
});

test('broadcaster closes every client during runtime shutdown', () => {
  const first = new FakeResponse();
  const second = new FakeResponse();
  assert.equal(broadcaster.addClient(first as never), true);
  assert.equal(broadcaster.addClient(second as never), true);

  broadcaster.closeAllClients();

  assert.equal(broadcaster.clientCount, 0);
  assert.equal(first.writableEnded, true);
  assert.equal(second.writableEnded, true);
});
