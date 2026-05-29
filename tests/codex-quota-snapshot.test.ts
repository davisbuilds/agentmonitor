import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCodexQuotaSnapshot } from '../src/provider-quotas/codex.js';

// Mirror just enough of ChildProcess to satisfy fetchCodexQuotaSnapshot's spawner seam.
function makeFakeChild(opts: {
  onStdin?: (chunk: string) => void;
  emitStdout?: (write: (line: string) => void) => void;
  exitAfterMs?: number;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => emitter.emit('exit', 0, null),
  });

  let stdinClosed = false;
  stdin.on('data', (chunk: Buffer) => opts.onStdin?.(chunk.toString('utf8')));
  stdin.on('end', () => {
    stdinClosed = true;
    // Mimic Codex CLI v0.133.0: if stdin closes before responses are written,
    // the server exits silently with no output.
    setImmediate(() => emitter.emit('exit', 0, null));
  });

  // Defer writes so the function has time to wire up its 'data' listener.
  setImmediate(() => {
    if (stdinClosed) return;
    opts.emitStdout?.((line) => stdout.write(line + '\n'));
    if (opts.exitAfterMs != null) {
      setTimeout(() => emitter.emit('exit', 0, null), opts.exitAfterMs);
    }
  });

  return child;
}

test('fetchCodexQuotaSnapshot parses rate limits from the JSON-RPC peer', async () => {
  let stdinBuffer = '';
  const snapshot = await fetchCodexQuotaSnapshot(2_000, {
    spawn: () =>
      makeFakeChild({
        onStdin: (chunk) => {
          stdinBuffer += chunk;
        },
        emitStdout: (write) => {
          write('{"id":1,"result":{"userAgent":"fake"}}');
          write('{"id":2,"result":{"account":{"email":"ndgee7@gmail.com","planType":"plus"}}}');
          write(
            '{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":24,"windowDurationMins":300,"resetsAt":1780063813},"secondary":{"usedPercent":57,"windowDurationMins":10080,"resetsAt":1780188058},"credits":{"hasCredits":true,"unlimited":false,"balance":"825.62"},"planType":"plus","rateLimitReachedType":null}}}',
          );
        },
      }),
  });

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.provider, 'codex');
  assert.equal(snapshot.account_label, 'ndgee7@gmail.com');
  assert.equal(snapshot.plan_type, 'plus');
  assert.equal(snapshot.limit_id, 'codex');
  assert.equal(snapshot.primary?.used_percent, 24);
  assert.equal(snapshot.primary?.window_minutes, 300);
  assert.equal(snapshot.secondary?.used_percent, 57);
  assert.equal(snapshot.credits?.balance, '825.62');
  // All 4 JSON-RPC frames were sent to the peer.
  assert.match(stdinBuffer, /"method":"initialize"/);
  assert.match(stdinBuffer, /"method":"account\/rateLimits\/read"/);
});

test('fetchCodexQuotaSnapshot does not close stdin before responses arrive', async () => {
  // Regression: Codex CLI v0.133.0 emits no responses when stdin EOFs before
  // the peer has written the rateLimits frame. The function must keep stdin
  // open and rely on child.kill() for cleanup.
  let stdinEndedBeforeResponse = false;
  let respondedAt: number | null = null;
  let endedAt: number | null = null;

  const snapshot = await fetchCodexQuotaSnapshot(3_000, {
    spawn: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      stdin.on('end', () => {
        endedAt = Date.now();
        if (respondedAt == null) stdinEndedBeforeResponse = true;
      });
      // Emit responses 50ms after the function spawns the child.
      setTimeout(() => {
        respondedAt = Date.now();
        stdout.write('{"id":1,"result":{}}\n');
        stdout.write('{"id":2,"result":{"account":{"email":"a@b.c","planType":"plus"}}}\n');
        stdout.write(
          '{"id":3,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":0}}}}\n',
        );
      }, 50);
      return Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        kill: () => emitter.emit('exit', 0, null),
      });
    },
  });

  assert.equal(snapshot.status, 'available', 'snapshot should succeed when the peer eventually responds');
  assert.equal(stdinEndedBeforeResponse, false, 'stdin must not close before responses arrive');
  // Sanity: if stdin was closed at all, it happened after the response.
  if (endedAt != null && respondedAt != null) {
    assert.ok(endedAt >= respondedAt, 'stdin close, if any, follows the response');
  }
});

test('fetchCodexQuotaSnapshot surfaces a diagnostic message when the peer exits silently', async () => {
  const snapshot = await fetchCodexQuotaSnapshot(1_000, {
    spawn: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      // Peer exits immediately with no stdout/stderr — the v0.133.0 regression shape.
      setImmediate(() => emitter.emit('exit', 0, null));
      return Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        kill: () => undefined,
      });
    },
  });

  assert.equal(snapshot.status, 'error');
  assert.ok(
    snapshot.error_message && snapshot.error_message.length > 0,
    `error_message should be diagnostic, got: ${JSON.stringify(snapshot.error_message)}`,
  );
});
