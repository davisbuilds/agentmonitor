import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexSessionMessages } from '../src/parser/codex-sessions.js';

const parse = (payload: Record<string, unknown>) => parseCodexSessionMessages(
  JSON.stringify({ type: 'session_meta', payload: { id: 'child', ...payload } }), 'child',
).metadata;

test('Codex native source evidence distinguishes conversations, delegation and internal work', () => {
  assert.equal(parse({ source: 'cli' }).relationship_type, 'conversation');
  const child = parse({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } });
  assert.equal(child.relationship_type, 'subagent');
  assert.equal(child.parent_session_id, 'parent');
  assert.equal(parse({ source: { subagent: 'compact' } }).relationship_type, 'internal');
  assert.equal(parse({ source: { subagent: 'memory_consolidation' } }).relationship_type, 'internal');
  assert.equal(parse({ source: 'future-source' }).relationship_type, null);
  assert.equal(parse({ originator: 'codex-tui' }).relationship_type, null,
    'originator is shared by internal jobs and is not classification evidence');
});

test('fork metadata alone does not turn a user conversation into a delegated agent', () => {
  assert.equal(parse({ source: 'cli', forked_from_id: 'parent' }).relationship_type, 'conversation');
  const child = parse({ thread_source: 'subagent', parent_thread_id: 'parent' });
  assert.equal(child.relationship_type, 'subagent');
  assert.equal(child.parent_session_id, 'parent');
});

test('native creation time is not moved backwards by inherited child history', () => {
  const parsed = parseCodexSessionMessages([
    { type: 'session_meta', payload: { timestamp: '2026-09-15T12:00:00Z', source: 'cli' } },
    { type: 'response_item', timestamp: '2026-09-14T12:00:00Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inherited context' }],
    } },
  ].map(row => JSON.stringify(row)).join('\n'), 'fork');
  assert.equal(parsed.metadata.started_at, '2026-09-15T12:00:00Z');
  assert.equal(parsed.metadata.ended_at, '2026-09-15T12:00:00Z');
  assert.equal(parsed.messages.length, 1, 'history stays browsable, but is not new work');
});
