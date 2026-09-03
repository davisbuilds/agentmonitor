import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIngestEvent } from '../src/contracts/event-contract.js';

test('normalizeIngestEvent normalizes a valid payload', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Bash',
    tokens_in: 12,
    tokens_out: 34,
    client_timestamp: '2026-02-18T10:00:00-05:00',
    metadata: { command: 'npm test' },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.event.status, 'success');
  assert.equal(result.event.client_timestamp, '2026-02-18T15:00:00.000Z');
  assert.equal(result.event.tokens_in, 12);
  assert.equal(result.event.tokens_out, 34);
});

test('normalizeIngestEvent applies error status default for error event_type', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'codex',
    event_type: 'error',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.event.status, 'error');
});

test('normalizeIngestEvent rejects invalid enums and numeric fields', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'codex',
    event_type: 'something_else',
    status: 'ok',
    tokens_in: -1,
    tokens_out: '5',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;

  const fields = result.errors.map(err => err.field);
  assert.ok(fields.includes('event_type'));
  assert.ok(fields.includes('status'));
  assert.ok(fields.includes('tokens_in'));
  assert.ok(fields.includes('tokens_out'));
});

test('normalizeIngestEvent accepts new P0 fields (model, cost_usd, cache tokens)', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: 'Read',
    model: 'claude-sonnet-4-5-20250929',
    cost_usd: 0.0045,
    tokens_in: 100,
    tokens_out: 500,
    cache_read_tokens: 50,
    cache_write_tokens: 10,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.event.model, 'claude-sonnet-4-5-20250929');
  assert.equal(result.event.cost_usd, 0.0045);
  assert.equal(result.event.cache_read_tokens, 50);
  assert.equal(result.event.cache_write_tokens, 10);
});

test('normalizeIngestEvent defaults cache tokens to 0 and cost_usd to undefined', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'response',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.event.cache_read_tokens, 0);
  assert.equal(result.event.cache_write_tokens, 0);
  assert.equal(result.event.cost_usd, undefined);
  assert.equal(result.event.model, undefined);
});

test('normalizeIngestEvent rejects negative cost_usd', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
    cost_usd: -1,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;

  const fields = result.errors.map(err => err.field);
  assert.ok(fields.includes('cost_usd'));
});

test('normalizeIngestEvent accepts expanded event types', () => {
  for (const eventType of [
    'llm_request',
    'llm_response',
    'file_change',
    'git_commit',
    'plan_step',
    'instruction_load',
  ]) {
    const result = normalizeIngestEvent({
      session_id: 'session-1',
      agent_type: 'claude_code',
      event_type: eventType,
    });

    assert.equal(result.ok, true, `Expected event_type "${eventType}" to be accepted`);
  }
});

test('normalizeIngestEvent preserves source field from input', () => {
  for (const source of ['hook', 'otel', 'import', 'api'] as const) {
    const result = normalizeIngestEvent({
      session_id: 'session-1',
      agent_type: 'claude_code',
      event_type: 'tool_use',
      source,
    });

    assert.equal(result.ok, true, `Expected source "${source}" to be accepted`);
    if (!result.ok) return;
    assert.equal(result.event.source, source, `Expected source to be "${source}"`);
  }
});

test('normalizeIngestEvent leaves source undefined when not provided', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'claude_code',
    event_type: 'tool_use',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.source, undefined);
});

test('normalizeIngestEvent rejects a non-object body', () => {
  for (const body of [null, 42, 'nope', ['a'], undefined] as const) {
    const result = normalizeIngestEvent(body);
    assert.equal(result.ok, false, `Expected ${JSON.stringify(body)} to be rejected`);
    if (result.ok) return;
    assert.deepEqual(result.errors, [{ field: 'body', message: 'must be a JSON object' }]);
  }
});

test('normalizeIngestEvent trims surrounding whitespace on string fields', () => {
  const result = normalizeIngestEvent({
    session_id: '  session-1  ',
    agent_type: '\tcodex\n',
    event_type: 'tool_use',
    tool_name: '  Bash  ',
    project: '  alpha  ',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.session_id, 'session-1');
  assert.equal(result.event.agent_type, 'codex');
  assert.equal(result.event.tool_name, 'Bash');
  assert.equal(result.event.project, 'alpha');
});

test('normalizeIngestEvent rejects a whitespace-only required field', () => {
  const result = normalizeIngestEvent({
    session_id: '   ',
    agent_type: 'codex',
    event_type: 'tool_use',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some(e => e.field === 'session_id' && /non-empty/.test(e.message)),
    'expected a non-empty-string error for session_id',
  );
});

test('normalizeIngestEvent rejects an unparseable client_timestamp and keeps other errors', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'codex',
    event_type: 'tool_use',
    client_timestamp: 'not-a-date',
    duration_ms: -5,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Errors aggregate — the whole payload is validated, not just the first failure.
  assert.ok(result.errors.some(e => e.field === 'client_timestamp'), 'timestamp error present');
  assert.ok(result.errors.some(e => e.field === 'duration_ms'), 'duration error present');
});

test('normalizeIngestEvent rejects a non-string client_timestamp', () => {
  const result = normalizeIngestEvent({
    session_id: 'session-1',
    agent_type: 'codex',
    event_type: 'tool_use',
    client_timestamp: 1739880000000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(e => e.field === 'client_timestamp'));
});
