import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSleepOverlap, parsePowerArchives, readLocalPowerHistory } from '../src/monitor/tool-timing-power.js';

const localHost = 'test-mac';
const day = '2026.01.02';
const midnight = Date.parse('2026-01-02T00:00:00Z');

function record(id: number, offsetMs: number, domain: string, signature = '', message = '', host = localHost, pid = 105): string {
  const timestampMs = midnight + offsetMs;
  return [
    id, Math.floor(timestampMs / 1000), timestampMs % 1000 * 1_000_000,
    host, pid, domain, signature, message,
  ].join('\t');
}

function range(startMs: number, endMs: number) {
  return { startMs: midnight + startMs, endMs: midnight + endMs };
}

function archive(date: string, ...records: string[]) {
  return { date, text: records.join('\n') };
}

const start = (id: number, offsetMs: number) => record(id, offsetMs, 'Start', '', 'powerd process is started');
const sleep = (id: number, offsetMs: number) => record(id, offsetMs, 'Sleep', 'success', 'Entering Sleep state');
const darkWake = (id: number, offsetMs: number) => record(id, offsetMs, 'DarkWake', 'success', 'DarkWake from Deep Idle');
const wake = (id: number, offsetMs: number) => record(id, offsetMs, 'Wake', 'success', 'Wake from Deep Idle');
const observation = (id: number, offsetMs: number) => record(id, offsetMs, 'Assertions');
const unknown = { coverage: 'unknown', sleepOverlapMs: null, coveredMs: 0 };

test('uses timestamp-bound suspend slices and excludes DarkWake from sleep overlap', () => {
  const history = parsePowerArchives([
    archive(day, start(1, 0), sleep(2, 1_200), darkWake(3, 2_510), sleep(4, 3_000), wake(5, 5_600),
      record(6, 6_000, 'Sleep', 'success', 'Entering DarkWake state'),
      record(7, 7_000, 'Wake', 'success', 'DarkWake to FullWake from Deep Idle'), observation(8, 8_000)),
  ], localHost);
  assert.deepEqual(measureSleepOverlap([range(1_500, 4_000), range(3_500, 5_900)], history), {
    coverage: 'complete', sleepOverlapMs: 3_610, coveredMs: 4_400,
  });
  assert.deepEqual(measureSleepOverlap([range(2_510, 3_000), range(6_000, 7_500)], history), {
    coverage: 'complete', sleepOverlapMs: 0, coveredMs: 1_990,
  });
});

test('leaves a missing ASL record and an open sleep unclassified', () => {
  const history = parsePowerArchives([
    archive(day, start(1, 0), sleep(2, 1_000), darkWake(3, 2_000), observation(4, 3_000),
      sleep(6, 4_000), wake(7, 5_000), sleep(8, 6_000), observation(9, 8_000)),
  ], localHost);
  assert.deepEqual(measureSleepOverlap([range(0, 9_000)], history), {
    coverage: 'partial', sleepOverlapMs: 2_000, coveredMs: 5_000,
  });
  assert.deepEqual(measureSleepOverlap([range(3_000, 4_000), range(6_000, 8_000)], history), unknown);
});

test('uses adjacent archives for a paired sleep but breaks across an archive gap', () => {
  const previousDay = archive('2026.01.01', sleep(8, -1_000));
  const currentDay = archive(day, wake(9, 1_000), observation(10, 2_000));
  const adjacent = parsePowerArchives([previousDay, currentDay], localHost);
  assert.deepEqual(measureSleepOverlap([range(-500, 1_500)], adjacent), {
    coverage: 'complete', sleepOverlapMs: 1_500, coveredMs: 2_000,
  });
  const gap = parsePowerArchives([archive('2025.12.31', sleep(8, -86_401_000)), currentDay], localHost);
  assert.deepEqual(measureSleepOverlap([range(-500, 500)], gap), unknown);
});

test('does not assume a sleep through a reboot or through inconsistent transitions', () => {
  const history = parsePowerArchives([
    archive(day, start(1, 0), sleep(2, 1_000), sleep(3, 2_000), darkWake(4, 3_000), sleep(5, 4_000),
      record(6, 10_000, 'Boot', '', '', localHost, 200),
      record(7, 11_000, 'Start', '', 'powerd process is started', localHost, 200),
      record(8, 12_000, 'Assertions', '', '', localHost, 200)),
  ], localHost);
  assert.deepEqual(measureSleepOverlap([range(0, 12_000)], history), {
    coverage: 'partial', sleepOverlapMs: 1_000, coveredMs: 4_000,
  });
  assert.deepEqual(measureSleepOverlap([range(4_000, 11_000)], history), unknown);
});

test('leaves the retained edges, a foreign archive, and absent history unknown', () => {
  const history = parsePowerArchives([archive(day, observation(1, 0), wake(2, 1_000), observation(3, 2_000))], localHost);
  assert.deepEqual(measureSleepOverlap([range(-1_000, 9_000)], history), {
    coverage: 'partial', sleepOverlapMs: 0, coveredMs: 1_000,
  });
  assert.equal(parsePowerArchives([archive(day, start(1, 0), observation(2, 1_000))], 'other-mac'), null);
  assert.deepEqual(measureSleepOverlap([range(0, 1_000)], null), unknown);
});

test('requires a positive range and returns unknown on platforms without the native archive', async () => {
  assert.equal(await readLocalPowerHistory([range(1_000, 1_000)]), null);
  if (process.platform !== 'darwin') {
    assert.equal(await readLocalPowerHistory([range(0, 1_000)]), null);
  }
});
