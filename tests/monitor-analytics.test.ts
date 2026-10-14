import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveAgentLabel,
  monitorCostWindowParams,
} from '../frontend/src/lib/monitor-analytics.ts';
import { createDefaultAnalyticsFilters } from '../frontend/src/lib/analytics-state.ts';

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

test('monitor cost windows are today and the same 30 days as Usage\'s default range', () => {
  const now = new Date(2026, 9, 14, 0, 30);
  const usage = createDefaultAnalyticsFilters(now);
  const windows = monitorCostWindowParams({}, now);

  assert.deepEqual(windows.today, { date_from: '2026-10-14', date_to: '2026-10-14' });
  assert.deepEqual(windows.last30Days, { date_from: usage.from, date_to: usage.to });
  assert.deepEqual(windows.last30Days, { date_from: '2026-09-15', date_to: '2026-10-14' });

  // Across a month end (2026 is not a leap year).
  assert.deepEqual(
    monitorCostWindowParams({}, new Date(2026, 2, 1, 23, 0)).last30Days,
    { date_from: '2026-01-31', date_to: '2026-03-01' },
  );
});

test('monitor cost windows carry only the project and agent filters', () => {
  const now = new Date(2026, 9, 14, 12, 0);
  const windows = monitorCostWindowParams({
    agent_type: 'codex',
    project: 'agentmonitor',
    model: 'gpt-5',
    event_type: 'tool_use',
    since: '2026-01-01T00:00:00.000Z',
  }, now);

  for (const params of [windows.today, windows.last30Days]) {
    assert.equal(params.agent, 'codex');
    assert.equal(params.project, 'agentmonitor');
    assert.deepEqual(Object.keys(params).sort(), ['agent', 'date_from', 'date_to', 'project']);
  }
});
