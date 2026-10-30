import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexSessionChunk, parseCodexSessionMessages } from '../src/parser/codex-sessions.js';

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
  // An approval review, as Codex Desktop writes it: no prompt of anyone's, so not delegated work either.
  assert.equal(parse({
    source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: 'parent',
  }).relationship_type, 'internal');
  assert.equal(parse({ source: 'future-source' }).relationship_type, null);
  assert.equal(parse({ source: { subagent: 'future-source' } }).relationship_type, null);
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

// UUIDv7 whose embedded time is `ms`, as Codex mints session and turn ids.
function uuidV7(ms: number, tail = '000000000000'): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail}`;
}

const SPAWNED_AT = Date.parse('2026-09-15T15:23:49Z');
const userMessage = (text: string) => ({ type: 'response_item', payload: {
  type: 'message', role: 'user', content: [{ type: 'input_text', text }],
} });
const assistantMessage = (text: string) => ({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
} });
const toolCall = (name: string) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{}' } });
const turn = (ms: number, model: string) => ({ type: 'turn_context', payload: { turn_id: uuidV7(ms), cwd: '/work', model } });
const spawnMeta = { type: 'session_meta', payload: {
  id: uuidV7(SPAWNED_AT, 'aaaaaaaaaaaa'), cwd: '/work', timestamp: '2026-09-15T15:23:49Z',
  source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }, thread_source: 'subagent',
} };
const rollout = (rows: unknown[]) => parseCodexSessionMessages(rows.map(row => JSON.stringify(row)).join('\n'), 'child');

test('a spawned subagent is browsed from its own first turn, not its copy of the parent', () => {
  const parsed = rollout([
    spawnMeta,
    { type: 'session_meta', payload: { id: 'parent', cwd: '/work', source: 'cli' } },
    { type: 'compacted', payload: { message: 'parent summary' } },
    turn(SPAWNED_AT - 60_000, 'parent-model'),
    userMessage('parent question'),
    assistantMessage('parent answer'),
    toolCall('parent_tool'),
    turn(SPAWNED_AT + 5, 'child-model'),
    assistantMessage('child work'),
    toolCall('child_tool'),
  ]);
  assert.deepEqual(parsed.messages.map(m => JSON.parse(m.content)[0].text ?? JSON.parse(m.content)[0].name),
    ['child work', 'child_tool']);
  assert.deepEqual(parsed.toolCalls.map(call => call.tool_name), ['child_tool']);
  assert.equal(parsed.metadata.user_message_count, 0);
  assert.equal(parsed.metadata.first_message, null, 'the title is not a parent message');
  assert.equal(parsed.metadata.parent_session_id, 'parent');
  assert.ok(!parsed.skillContext.observations.some(o => o.kind === 'compaction'), 'the parent\'s compaction is not the child\'s');
});

test('a spawned subagent keeps the instruction preamble written before any turn', () => {
  const parsed = rollout([
    spawnMeta,
    userMessage('# AGENTS.md instructions for /work'),
    turn(SPAWNED_AT + 5, 'child-model'),
    assistantMessage('child work'),
  ]);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.metadata.first_message, null, 'the preamble stays browsable but is not a title');
});

test('a preamble ahead of a copied span stays with the child', () => {
  const parsed = rollout([
    spawnMeta,
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'child instructions' }] } },
    turn(SPAWNED_AT - 60_000, 'parent-model'),
    userMessage('parent question'),
    turn(SPAWNED_AT + 5, 'child-model'),
    assistantMessage('child work'),
  ]);
  assert.deepEqual(parsed.messages.map(m => JSON.parse(m.content)[0].text), ['child instructions', 'child work']);
});

test('a child\'s own compaction before its first surviving turn is kept', () => {
  // Without inherited turns there is no copy: a compacted record here is the
  // child's own earlier work, not the parent's.
  const parsed = rollout([
    spawnMeta,
    { type: 'compacted', payload: { message: 'child summary' } },
    turn(SPAWNED_AT + 5, 'child-model'),
    assistantMessage('child work'),
  ]);
  assert.ok(parsed.skillContext.observations.some(o => o.kind === 'compaction'));
  assert.equal(parsed.messages.length, 1);
});

test('an older copy with requests but no turn records is still dropped', () => {
  const parsed = rollout([
    spawnMeta,
    { type: 'compacted', payload: { message: 'parent summary' } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    userMessage('parent question'),
    turn(SPAWNED_AT + 5, 'child-model'),
    assistantMessage('child work'),
  ]);
  assert.deepEqual(parsed.messages.map(m => JSON.parse(m.content)[0].text), ['child work']);
});

test('a spawned subagent without a turn of its own is kept whole', () => {
  const parsed = rollout([
    spawnMeta,
    turn(SPAWNED_AT - 60_000, 'parent-model'),
    userMessage('parent question'),
  ]);
  assert.equal(parsed.messages.length, 1, 'an unresolved boundary is not guessed at');
});

test('a user fork keeps its inherited turns', () => {
  const parsed = rollout([
    { type: 'session_meta', payload: { id: uuidV7(SPAWNED_AT), source: 'cli', forked_from_id: 'parent' } },
    turn(SPAWNED_AT - 60_000, 'parent-model'),
    userMessage('parent question'),
    turn(SPAWNED_AT + 5, 'child-model'),
    userMessage('fork question'),
  ]);
  assert.equal(parsed.metadata.user_message_count, 2);
});

test("a conversation's first prompt skips the context Codex injects ahead of it", () => {
  const parsed = rollout([
    { type: 'session_meta', payload: { id: 'conv', cwd: '/work', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' },
    ] } },
    userMessage('Review the open pull request'),
    assistantMessage('Looking now.'),
  ]);
  assert.equal(parsed.metadata.first_message, 'Review the open pull request');
  assert.equal(parsed.metadata.user_message_count, 2, 'injected context still counts as a user message');
});

test('a spawned subagent is titled by the task name its parent gave it', () => {
  const meta = { type: 'session_meta', payload: {
    ...spawnMeta.payload,
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: '/root/emil_pstack' } } },
  } };
  const first = parseCodexSessionChunk([meta, turn(SPAWNED_AT + 5, 'child-model')]
    .map(row => JSON.stringify(row)).join('\n') + '\n', 'child');
  assert.equal(first.parsed.metadata.title, 'emil pstack');
  const resumed = parseCodexSessionChunk(JSON.stringify(assistantMessage('more work')) + '\n',
    'child', undefined, first.state);
  assert.equal(resumed.parsed.metadata.title, 'emil pstack');
});
