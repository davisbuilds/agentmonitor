import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  dateParamLowerBound,
  dateParamUpperExclusive,
  localDayEndExclusive,
  localDayOf,
  localDayStart,
  localWeekdayHour,
} from '../src/util/local-day.js';
import { resolveReportingTimeZone } from '../src/util/time-zone.js';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

describe('localDayOf', () => {
  test('a late-evening instant belongs to the local day, not the UTC one', () => {
    assert.equal(localDayOf('2026-09-11T02:00:00Z', NY), '2026-09-10');
    assert.equal(localDayOf('2026-09-10T20:00:00Z', TOKYO), '2026-09-11');
  });

  test('reads SQLite zone-less timestamps as UTC, whatever the host zone', () => {
    assert.equal(localDayOf('2026-09-11 02:00:00', NY), '2026-09-10');
    assert.equal(localDayOf('2026-09-11T02:00:00', NY), '2026-09-10');
  });

  test('honors an explicit offset', () => {
    assert.equal(localDayOf('2026-09-10T23:30:00-04:00', NY), '2026-09-10');
    assert.equal(localDayOf('2026-09-10T23:30:00-04:00', TOKYO), '2026-09-11');
  });

  test('returns null for an unparseable timestamp', () => {
    assert.equal(localDayOf('not-a-time', NY), null);
  });
});

describe('local day bounds', () => {
  test('an ordinary day runs between two local midnights', () => {
    assert.equal(localDayStart('2026-09-10', NY), '2026-09-10T04:00:00.000Z');
    assert.equal(localDayEndExclusive('2026-09-10', NY), '2026-09-11T04:00:00.000Z');
    assert.equal(localDayStart('2026-09-10', TOKYO), '2026-09-09T15:00:00.000Z');
  });

  test('the spring-forward day is 23 hours long', () => {
    assert.equal(localDayStart('2026-03-08', NY), '2026-03-08T05:00:00.000Z');
    assert.equal(localDayEndExclusive('2026-03-08', NY), '2026-03-09T04:00:00.000Z');
  });

  test('the fall-back day is 25 hours long', () => {
    assert.equal(localDayStart('2026-11-01', NY), '2026-11-01T04:00:00.000Z');
    assert.equal(localDayEndExclusive('2026-11-01', NY), '2026-11-02T05:00:00.000Z');
  });
});

describe('date params', () => {
  test('a bare day becomes its local midnights', () => {
    assert.equal(dateParamLowerBound('2026-09-10', NY), '2026-09-10T04:00:00.000Z');
    assert.equal(dateParamUpperExclusive('2026-09-10', NY), '2026-09-11T04:00:00.000Z');
  });

  test('a timestamp stays an instant, the upper bound covering its whole second', () => {
    assert.equal(dateParamLowerBound('2026-09-15T12:34:56.789Z', NY), '2026-09-15T12:34:56.789Z');
    assert.equal(dateParamUpperExclusive('2026-09-15T12:34:56.789Z', NY), '2026-09-15T12:34:57.000Z');
  });
});

describe('localWeekdayHour', () => {
  test('buckets by local weekday (Monday = 0) and hour', () => {
    // Friday 02:00 UTC is Thursday 22:00 EDT.
    assert.deepEqual(localWeekdayHour('2026-09-11T02:00:00Z', NY), { weekday: 3, hour: 22 });
    assert.deepEqual(localWeekdayHour('2026-09-11T02:00:00Z', TOKYO), { weekday: 4, hour: 11 });
  });
});

describe('resolveReportingTimeZone', () => {
  test('uses a valid configured zone', () => {
    assert.equal(resolveReportingTimeZone({ AGENTMONITOR_TIMEZONE: TOKYO }), TOKYO);
  });

  test('falls back to the host zone when unset or invalid', () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(resolveReportingTimeZone({}), host);
    assert.equal(resolveReportingTimeZone({ AGENTMONITOR_TIMEZONE: 'Not/AZone' }), host);
  });
});
