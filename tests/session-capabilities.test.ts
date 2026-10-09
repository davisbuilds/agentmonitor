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

test('getCapabilityEntries lists every capability in a fixed display order', () => {
  const entries = getCapabilityEntries({
    history: 'full',
    search: 'summary',
    tool_analytics: 'none',
    live_items: 'full',
  });
  assert.deepEqual(entries, [
    { key: 'history', label: 'History', shortLabel: 'Hist', level: 'full' },
    { key: 'search', label: 'Search', shortLabel: 'Search', level: 'summary' },
    { key: 'tool_analytics', label: 'Tool Analytics', shortLabel: 'Tools', level: 'none' },
    { key: 'live_items', label: 'Live Items', shortLabel: 'Live', level: 'full' },
  ]);
  assert.deepEqual(getCapabilityEntries(null), []);
});

test('capabilityLevelText names each level', () => {
  assert.equal(capabilityLevelText('full'), 'full');
  assert.equal(capabilityLevelText('summary'), 'summary');
  assert.equal(capabilityLevelText('none'), 'off');
});

test('hasSessionCapability is false without a contract and thresholds at the minimum inclusively', () => {
  assert.equal(hasSessionCapability(null, 'history'), false);
  assert.equal(hasSessionCapability(null, 'history', 'none'), false);
  const caps = { history: 'summary', search: 'full', tool_analytics: 'none', live_items: 'none' } as const;
  assert.equal(hasSessionCapability(caps, 'history'), true); // summary meets the default minimum
  assert.equal(hasSessionCapability(caps, 'history', 'full'), false);
  assert.equal(hasSessionCapability(caps, 'search', 'full'), true);
  assert.equal(hasSessionCapability(caps, 'tool_analytics'), false);
  assert.equal(hasSessionCapability(caps, 'tool_analytics', 'none'), true);
});

test('summarizeCapabilities names exactly what is available and missing, in display order', () => {
  const partial = summarizeCapabilities({
    history: 'full',
    search: 'summary',
    tool_analytics: 'none',
    live_items: 'summary',
  });
  assert.equal(partial.tone, 'mixed');
  // A summary-level capability counts as available, not missing.
  assert.equal(partial.description, 'Available: history, search, live items. Missing: tool analytics.');

  const none = summarizeCapabilities({ history: 'none', search: 'none', tool_analytics: 'none', live_items: 'none' });
  assert.equal(none.label, 'partial surface');
  assert.equal(none.description, 'Available: none. Missing: history, search, tool analytics, live items.');

  // Not every-full: one summary level breaks the full surface.
  const almost = summarizeCapabilities({ history: 'full', search: 'full', tool_analytics: 'summary', live_items: 'full' });
  assert.equal(almost.tone, 'mixed');
  assert.equal(almost.description, 'Available: history, search, tool analytics, live items. Missing: none.');
});

test('summarizeCapabilities tones distinguish full, live-only, and unknown contracts', () => {
  assert.equal(summarizeCapabilities({ history: 'full', search: 'full', tool_analytics: 'full', live_items: 'full' }).tone, 'full');
  const liveFull = summarizeCapabilities({ history: 'none', search: 'none', tool_analytics: 'none', live_items: 'full' });
  assert.equal(liveFull.label, 'live surface only');
  assert.equal(liveFull.tone, 'summary');
  // Live plus any transcript capability is no longer "live only".
  assert.equal(
    summarizeCapabilities({ history: 'summary', search: 'none', tool_analytics: 'none', live_items: 'full' }).label,
    'partial surface',
  );
  assert.equal(summarizeCapabilities(null).tone, 'unknown');
});
