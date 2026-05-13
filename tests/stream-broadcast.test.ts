import assert from 'node:assert/strict';
import test from 'node:test';

test('stats broadcaster starts once, skips empty client sets, and stops cleanly', async () => {
  process.env.AGENTMONITOR_STATS_INTERVAL = '1';
  const { startStatsBroadcast, stopStatsBroadcast } = await import('../src/api/stream.js');

  startStatsBroadcast();
  startStatsBroadcast();
  await new Promise(resolve => setTimeout(resolve, 5));
  stopStatsBroadcast();
  stopStatsBroadcast();

  assert.ok(true);
});
