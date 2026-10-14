import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityLevelLabel,
  describeCoverage,
  getCapabilityEntries,
  hasSessionCapability,
  sessionSourceLabel,
} from '../frontend/src/lib/session-capabilities.ts';

const caps = (history: string, search: string, tool_analytics: string, live_items: string) =>
  ({ history, search, tool_analytics, live_items }) as Parameters<typeof describeCoverage>[0];

test('a fully captured session is full detail, which lists leave unsaid', () => {
  assert.deepEqual(describeCoverage(caps('full', 'full', 'full', 'full')), { label: 'Full detail', tone: 'ok', full: true });
});

test('sessions with less to show are named in plain words', () => {
  assert.deepEqual(describeCoverage(caps('summary', 'summary', 'summary', 'summary')), { label: 'Summary detail', tone: 'warn', full: false });
  assert.deepEqual(describeCoverage(caps('summary', 'none', 'summary', 'summary')), { label: 'Summary detail', tone: 'warn', full: false });
  assert.deepEqual(describeCoverage(caps('none', 'none', 'none', 'summary')), { label: 'Live activity only', tone: 'warn', full: false });
  assert.deepEqual(describeCoverage(caps('none', 'none', 'none', 'full')), { label: 'Live activity only', tone: 'warn', full: false });
  assert.deepEqual(describeCoverage(caps('none', 'none', 'none', 'none')), { label: 'No detail', tone: 'neutral', full: false });
  assert.deepEqual(describeCoverage(null), { label: 'Detail unknown', tone: 'neutral', full: false });
});

test('one level below full makes a session partial', () => {
  assert.deepEqual(describeCoverage(caps('full', 'full', 'summary', 'full')), { label: 'Partial detail', tone: 'accent', full: false });
  assert.deepEqual(describeCoverage(caps('full', 'full', 'none', 'full')), { label: 'Partial detail', tone: 'accent', full: false });
  assert.deepEqual(describeCoverage(caps('summary', 'none', 'none', 'full')), { label: 'Partial detail', tone: 'accent', full: false });
});

test('getCapabilityEntries lists every capability in a fixed order with a readable level', () => {
  assert.deepEqual(
    getCapabilityEntries(caps('full', 'summary', 'none', 'full')).map(entry => [entry.key, entry.label, capabilityLevelLabel(entry.level)]),
    [
      ['history', 'Transcript', 'Full'],
      ['search', 'Search', 'Summary'],
      ['tool_analytics', 'Tool analytics', 'Not available'],
      ['live_items', 'Live stream', 'Full'],
    ],
  );
  assert.deepEqual(getCapabilityEntries(null), []);
});

test('sessionSourceLabel names where a session came from', () => {
  assert.equal(sessionSourceLabel('claude-jsonl'), 'Claude Code transcript');
  assert.equal(sessionSourceLabel('codex-jsonl'), 'Codex rollout file');
  assert.equal(sessionSourceLabel('codex-otel'), 'Codex telemetry');
  assert.equal(sessionSourceLabel('codex-import'), 'Codex history import');
  assert.equal(sessionSourceLabel('codex-summary'), 'Codex summary');
  assert.equal(sessionSourceLabel('antigravity-sqlite'), 'Antigravity');
  assert.equal(sessionSourceLabel('something-new'), 'something-new');
  assert.equal(sessionSourceLabel(null), 'Unknown source');
});

test('hasSessionCapability is false without a contract and thresholds at the minimum inclusively', () => {
  assert.equal(hasSessionCapability(null, 'history'), false);
  assert.equal(hasSessionCapability(null, 'history', 'none'), false);
  const summaryHistory = caps('summary', 'full', 'none', 'none');
  assert.equal(hasSessionCapability(summaryHistory, 'history'), true); // summary meets the default minimum
  assert.equal(hasSessionCapability(summaryHistory, 'history', 'full'), false);
  assert.equal(hasSessionCapability(summaryHistory, 'search', 'full'), true);
  assert.equal(hasSessionCapability(summaryHistory, 'tool_analytics'), false);
  assert.equal(hasSessionCapability(summaryHistory, 'tool_analytics', 'none'), true);
});
