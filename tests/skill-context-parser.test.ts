import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionMessages } from '../src/parser/claude-code.js';
import { parseCodexSessionMessages } from '../src/parser/codex-sessions.js';

const catalog = `<skills_instructions>
<skills>
<skill><name>test-strategy</name><description>Test behavior.</description><location>/skills/test-strategy/SKILL.md</location><scope>global</scope></skill>
</skills>
</skills_instructions>`;

test('Claude preserves consultations and compaction in source order', () => {
  const parsed = parseSessionMessages([
    JSON.stringify({
      type: 'assistant',
      cwd: '/work/alpha',
      timestamp: '2026-07-01T00:00:01Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'one', name: 'Skill', input: { skill: 'test-strategy' } }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      cwd: '/work/alpha',
      timestamp: '2026-07-01T00:00:02Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'two', name: 'Skill', input: { skill: 'test-strategy' } }],
      },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      cwd: '/work/alpha',
      timestamp: '2026-07-01T00:00:03Z',
    }),
    JSON.stringify({
      type: 'assistant',
      cwd: '/work/beta',
      timestamp: '2026-07-01T00:00:04Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'three', name: 'Skill', input: { skill: 'test-strategy' } }],
      },
    }),
  ].join('\n'), 'claude-context');

  assert.deepEqual(
    parsed.skillContext?.observations.map(observation => [
      observation.kind,
      observation.skillName ?? null,
      observation.ordinal,
    ]),
    [
      ['consultation', 'test-strategy', 0],
      ['consultation', 'test-strategy', 1],
      ['compaction', null, 2],
      ['consultation', 'test-strategy', 3],
    ],
  );
  assert.equal(parsed.skillContext?.capabilities.orderedConsultations.observable, true);
  assert.notEqual(
    parsed.skillContext?.observations[0]?.projectIdentity,
    parsed.skillContext?.observations[3]?.projectIdentity,
  );
});

test('Codex preserves initial and post-compaction catalog occurrences', () => {
  const parsed = parseCodexSessionMessages([
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-01T00:00:00Z',
      payload: { cwd: '/work/alpha', originator: 'codex_cli_rs' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:01Z',
      payload: {
        role: 'developer',
        content: [{ type: 'input_text', text: catalog }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:02Z',
      payload: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'sed -n 1,80p /skills/test-strategy/SKILL.md' }),
      },
    }),
    JSON.stringify({
      type: 'compacted',
      timestamp: '2026-07-01T00:00:03Z',
      payload: {
        replacement_history: [{
          type: 'response_item',
          payload: {
            role: 'developer',
            content: [{
              type: 'input_text',
              text: catalog.replace('Test behavior.', 'Test behavior carefully.'),
            }],
          },
        }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:04Z',
      payload: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat /skills/test-strategy/SKILL.md' }),
      },
    }),
  ].join('\n'), 'codex-context');

  const observations = parsed.skillContext?.observations ?? [];
  assert.equal(observations.filter(item => item.kind === 'consultation').length, 2);
  assert.equal(observations.filter(item => item.kind === 'compaction').length, 1);
  const presentations = observations.filter(item => item.kind === 'catalog_presentation');
  assert.equal(presentations.length, 2);
  assert.notEqual(
    presentations[0]?.metadata?.['fingerprint'],
    presentations[1]?.metadata?.['fingerprint'],
  );
  assert.deepEqual(presentations[0]?.catalogEntries?.map(entry => entry.name), ['test-strategy']);
  assert.equal(
    (presentations[0]?.metadata?.['measurement'] as { unit?: string }).unit,
    'utf8_bytes',
  );
});

test('malformed retained source degrades capability without discarding detected consultations', () => {
  const parsed = parseCodexSessionMessages([
    '{"broken":',
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:01Z',
      payload: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat /skills/diagnose/SKILL.md' }),
      },
    }),
  ].join('\n'), 'codex-degraded');

  assert.equal(parsed.skillContext?.observations.length, 1);
  assert.equal(parsed.skillContext?.capabilities.orderedConsultations.observable, false);
  assert.equal(
    parsed.skillContext?.capabilities.orderedConsultations.reason,
    'malformed_source_record',
  );
});
