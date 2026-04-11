import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityLevelText,
  getCapabilityEntries,
  hasSessionCapability,
  summarizeCapabilities,
} from '../frontend/src/lib/session-capabilities.ts';

test('summarizes full projection coverage', () => {
  const capabilities = {
    history: 'full',
    search: 'full',
    tool_analytics: 'full',
    live_items: 'full',
  } as const;

  assert.equal(summarizeCapabilities(capabilities).label, 'full surface');
  assert.equal(getCapabilityEntries(capabilities).length, 4);
  assert.equal(capabilityLevelText(capabilities.history), 'full');
  assert.equal(hasSessionCapability(capabilities, 'search'), true);
});

test('summarizes live-only coverage and thresholds missing history', () => {
  const capabilities = {
    history: 'none',
    search: 'none',
    tool_analytics: 'none',
    live_items: 'summary',
  } as const;

  const summary = summarizeCapabilities(capabilities);

  assert.equal(summary.label, 'live summary only');
  assert.match(summary.description, /Live items are available/i);
  assert.equal(hasSessionCapability(capabilities, 'history'), false);
  assert.equal(hasSessionCapability(capabilities, 'live_items'), true);
  assert.equal(hasSessionCapability(capabilities, 'live_items', 'full'), false);
  assert.equal(capabilityLevelText(capabilities.history), 'off');
});

test('summarizes mixed coverage and unknown contracts', () => {
  const partial = {
    history: 'full',
    search: 'summary',
    tool_analytics: 'none',
    live_items: 'summary',
  } as const;

  assert.equal(summarizeCapabilities(partial).label, 'partial surface');
  assert.equal(summarizeCapabilities(null).label, 'capabilities unknown');
});
