import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveAgentLabel,
  buildCostFilters,
  formatMonitorCost,
  shortModelName,
} from '../frontend/src/lib/monitor-analytics.ts';

test('buildCostFilters applies rolling since window when no explicit since exists', () => {
  const filters = buildCostFilters({ project: 'agentmonitor' }, '60d', new Date('2026-04-10T12:00:00.000Z'));

  assert.equal(filters.project, 'agentmonitor');
  assert.equal(filters.since, '2026-02-09T12:00:00.000Z');
});

test('buildCostFilters preserves explicit since and all-time selection', () => {
  assert.deepEqual(
    buildCostFilters({ since: '2026-01-01T00:00:00.000Z' }, '30d', new Date('2026-04-10T12:00:00.000Z')),
    { since: '2026-01-01T00:00:00.000Z' },
  );

  assert.deepEqual(
    buildCostFilters({ agent_type: 'codex' }, 'all', new Date('2026-04-10T12:00:00.000Z')),
    { agent_type: 'codex' },
  );

  assert.deepEqual(
    buildCostFilters({ project: 'agentmonitor' }, 'all', new Date('2026-04-10T12:00:00.000Z')),
    { project: 'agentmonitor' },
  );
});

test('formatMonitorCost preserves operator-friendly small values', () => {
  assert.equal(formatMonitorCost(0), '$0.00');
  assert.equal(formatMonitorCost(0.004), '<$0.01');
  assert.equal(formatMonitorCost(0.1234), '$0.123');
  assert.equal(formatMonitorCost(1.234), '$1.23');
});

test('buildActiveAgentLabel includes model and reasoning effort when available', () => {
  assert.equal(
    buildActiveAgentLabel('codex', [
      { metadata: { reasoning_effort: 'high' } },
      { model: 'openai/gpt-5.5' },
    ]),
    'Codex (gpt-5.5 high)',
  );
});

test('buildActiveAgentLabel uses the friendly agent name and omits unavailable model metadata', () => {
  assert.equal(buildActiveAgentLabel('claude_code', []), 'Claude');
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.4', metadata: '{bad json' }]),
    'Codex (gpt-5.4)',
  );
});

test('buildActiveAgentLabel falls back to the raw type for unknown agents', () => {
  assert.equal(buildActiveAgentLabel('amp', [{ model: 'gpt-5.4' }]), 'amp (gpt-5.4)');
});

test('buildActiveAgentLabel skips the <synthetic> marker and falls through to the real model', () => {
  // Events are newest-first; a synthetic rate-limit/error turn (model "<synthetic>",
  // written by Claude Code itself) must not overwrite the last real model.
  assert.equal(
    buildActiveAgentLabel('claude_code', [
      { model: '<synthetic>' },
      { model: 'anthropic/claude-opus-4-7' },
    ]),
    'Claude (claude-opus-4-7)',
  );
});

test('buildActiveAgentLabel drops the suffix when the only model is <synthetic>', () => {
  assert.equal(
    buildActiveAgentLabel('claude_code', [{ model: '<synthetic>' }]),
    'Claude',
  );
});

test('shortModelName compacts known provider model families', () => {
  assert.equal(shortModelName(''), 'unknown');
  assert.equal(shortModelName('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModelName('claude-opus-4-7'), 'opus-4.7');
  assert.equal(shortModelName('claude-opus-4-6-20260101'), 'opus-4.6');
  assert.equal(shortModelName('claude-opus-4-5-20260101'), 'opus-4.5');
  assert.equal(shortModelName('claude-haiku-4-5-20260101'), 'haiku-4.5');
  assert.equal(shortModelName('claude-3-5-sonnet-20241022'), 'sonnet-3.5');
  assert.equal(shortModelName('claude-3-5-haiku-20241022'), 'haiku-3.5');
  assert.equal(shortModelName('claude-3-opus-20240229'), 'opus-3');
  assert.equal(shortModelName('claude-custom'), 'c-custom');
  assert.equal(shortModelName('gpt-5.5'), 'gpt-5.5');
});

test('buildCostFilters subtracts exactly the window length for every rolling option', () => {
  const now = new Date('2026-04-10T12:00:00.000Z');
  const day = 86_400_000;
  for (const [window, days] of [['30d', 30], ['60d', 60], ['90d', 90]] as const) {
    assert.equal(
      buildCostFilters({}, window, now).since,
      new Date(now.getTime() - days * day).toISOString(),
      window,
    );
  }
  // Spot-check the 30d edge as a literal so a shared off-by-one cannot hide.
  assert.equal(buildCostFilters({}, '30d', now).since, '2026-03-11T12:00:00.000Z');
});

test('buildCostFilters treats an empty since as absent and never mutates the caller filters', () => {
  const now = new Date('2026-04-10T12:00:00.000Z');
  const input = { since: '', project: 'p' };
  const out = buildCostFilters(input, '30d', now);
  assert.equal(out.since, '2026-03-11T12:00:00.000Z');
  assert.equal(out.project, 'p');
  assert.deepEqual(input, { since: '', project: 'p' }); // caller object untouched
  assert.notEqual(out, input);
});

test('formatMonitorCost switches precision exactly at one cent and one dollar', () => {
  assert.equal(formatMonitorCost(null), '$0.00');
  assert.equal(formatMonitorCost(undefined), '$0.00');
  assert.equal(formatMonitorCost(0.0099), '<$0.01');
  assert.equal(formatMonitorCost(0.01), '$0.010'); // one cent is shown, not hidden as "<$0.01"
  assert.equal(formatMonitorCost(0.999), '$0.999');
  assert.equal(formatMonitorCost(1), '$1.00'); // a dollar uses cents precision
  assert.equal(formatMonitorCost(1234.5), '$1234.50');
});

test('buildActiveAgentLabel takes the newest real model (events are newest-first)', () => {
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.5' }, { model: 'gpt-5.4' }]),
    'Codex (gpt-5.5)',
  );
  // Whitespace-only and missing models are skipped like <synthetic>.
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: '   ' }, {}, { model: ' gpt-5.4 ' }]),
    'Codex (gpt-5.4)',
  );
});

test('buildActiveAgentLabel reads effort from reasoning_effort or thinking_level, normalized', () => {
  // thinking_level (Antigravity/Gemini style) is honoured, trimmed and lowercased.
  assert.equal(
    buildActiveAgentLabel('antigravity', [{ model: 'google/gemini-3-pro', metadata: { thinking_level: ' HIGH ' } }]),
    'Antigravity (gemini-3-pro high)',
  );
  // Metadata may arrive as a JSON string.
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.5', metadata: '{"reasoning_effort":"Medium"}' }]),
    'Codex (gpt-5.5 medium)',
  );
  // reasoning_effort wins over thinking_level; a blank one falls through.
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.5', metadata: { reasoning_effort: 'low', thinking_level: 'high' } }]),
    'Codex (gpt-5.5 low)',
  );
  assert.equal(
    buildActiveAgentLabel('codex', [{ model: 'gpt-5.5', metadata: { reasoning_effort: ' ', thinking_level: 'high' } }]),
    'Codex (gpt-5.5 high)',
  );
  // A JSON array is not metadata.
  assert.equal(buildActiveAgentLabel('codex', [{ model: 'gpt-5.5', metadata: '["high"]' }]), 'Codex (gpt-5.5)');
});

test('buildActiveAgentLabel shows effort only alongside a model', () => {
  assert.equal(buildActiveAgentLabel('codex', [{ metadata: { reasoning_effort: 'high' } }]), 'Codex');
});

test('buildActiveAgentLabel names every recognized agent and strips only known provider prefixes', () => {
  assert.equal(buildActiveAgentLabel('claude', []), 'Claude');
  assert.equal(buildActiveAgentLabel('antigravity', []), 'Antigravity');
  assert.equal(buildActiveAgentLabel('codex', [{ model: 'openai/gpt-5.5' }]), 'Codex (gpt-5.5)');
  assert.equal(buildActiveAgentLabel('claude', [{ model: 'anthropic/claude-opus-4-7' }]), 'Claude (claude-opus-4-7)');
  assert.equal(buildActiveAgentLabel('antigravity', [{ model: 'google/gemini-3-pro' }]), 'Antigravity (gemini-3-pro)');
  // Unknown provider prefixes stay visible rather than being guessed away.
  assert.equal(buildActiveAgentLabel('amp', [{ model: 'x-ai/grok-5' }]), 'amp (x-ai/grok-5)');
});

test('shortModelName compacts dated variants of the undated families too', () => {
  assert.equal(shortModelName('claude-opus-4-7-20260301'), 'opus-4.7');
  assert.equal(shortModelName('claude-opus-4-6'), 'opus-4.6');
});
