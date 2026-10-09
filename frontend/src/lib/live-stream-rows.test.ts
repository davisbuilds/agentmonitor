import { describe, it, expect } from 'vitest';
import type { LiveItem } from './api/client';
import { buildLiveStreamRows, pairedToolResult, rowBody, rowFailed, rowLabel, toolArgument } from './live-stream-rows';
import { isNotableStatus } from './status';

let nextId = 1;
function item(kind: string, sourceItemId: string | null, payload: object = {}, extra: Partial<LiveItem> = {}): LiveItem {
  return {
    id: nextId++,
    session_id: 's1',
    turn_id: null,
    ordinal: 0,
    source_item_id: sourceItemId,
    kind,
    status: 'success',
    payload_json: JSON.stringify(payload),
    created_at: null,
    ...extra,
  };
}

const shape = (items: LiveItem[]) => buildLiveStreamRows(items).map(row => [row.item.id, row.result?.id ?? null]);

describe('buildLiveStreamRows', () => {
  it('folds a Claude tool result into the call that shares its tool_use id', () => {
    const call = item('tool_call', 'toolu_1', { tool_name: 'Bash' });
    const text = item('assistant_message', 'm:1', { text: 'Running it' });
    const result = item('tool_result', 'toolu_1', { content: 'ok' });
    expect(shape([call, text, result])).toEqual([[call.id, result.id], [text.id, null]]);
  });

  it('folds a Codex result into its call through call_id, though their ids differ', () => {
    const call = item('tool_call', 'exec-1:decision', { tool_name: 'exec_command', call_id: 'exec-1' });
    const result = item('tool_result', 'exec-1:result', { tool_name: 'exec_command', call_id: 'exec-1' });
    expect(shape([call, result])).toEqual([[call.id, result.id]]);
  });

  it('pairs interleaved calls with their own results', () => {
    const a = item('tool_call', 'toolu_a');
    const b = item('tool_call', 'toolu_b');
    const resultB = item('tool_result', 'toolu_b');
    const resultA = item('tool_result', 'toolu_a');
    expect(shape([a, b, resultB, resultA])).toEqual([[a.id, resultA.id], [b.id, resultB.id]]);
  });

  it('keeps a result whose call is outside the loaded window as its own row', () => {
    const result = item('tool_result', 'toolu_gone');
    expect(shape([result])).toEqual([[result.id, null]]);
  });

  it('keeps a second result for an already answered call as its own row', () => {
    const call = item('tool_call', 'toolu_2');
    const first = item('tool_result', 'toolu_2');
    const second = item('tool_result', 'toolu_2');
    expect(shape([call, first, second])).toEqual([[call.id, first.id], [second.id, null]]);
  });

  it('does not pair a result that comes before its call', () => {
    const result = item('tool_result', 'toolu_3');
    const call = item('tool_call', 'toolu_3');
    expect(shape([result, call])).toEqual([[result.id, null], [call.id, null]]);
  });

  it('does not pair items without an id', () => {
    const call = item('tool_call', null);
    const result = item('tool_result', null);
    expect(shape([call, result])).toEqual([[call.id, null], [result.id, null]]);
  });

  it('does not pair across sessions', () => {
    const call = item('tool_call', 'toolu_4');
    const result = item('tool_result', 'toolu_4', {}, { session_id: 's2' });
    expect(shape([call, result])).toEqual([[call.id, null], [result.id, null]]);
  });

  it('returns no rows for no items', () => {
    expect(buildLiveStreamRows([])).toEqual([]);
  });
});

describe('pairedToolResult', () => {
  it('finds the result folded into a call and nothing for other kinds', () => {
    const call = item('tool_call', 'toolu_5');
    const result = item('tool_result', 'toolu_5');
    expect(pairedToolResult([call, result], call)?.id).toBe(result.id);
    expect(pairedToolResult([call, result], result)).toBeNull();
    expect(pairedToolResult([call, result], null)).toBeNull();
  });
});

describe('isNotableStatus', () => {
  it('leaves the routine success states unsaid', () => {
    for (const status of ['success', 'completed', 'ok', 'Success', ' completed ', '', null, undefined]) {
      expect(isNotableStatus(status), String(status)).toBe(false);
    }
  });

  it('shows every other status', () => {
    for (const status of ['error', 'failed', 'running', 'in_progress', 'timeout', 'session_start']) {
      expect(isNotableStatus(status), status).toBe(true);
    }
  });
});

describe('rowFailed', () => {
  it('flags a failed result, an errored call, or a payload that reports failure', () => {
    const call = item('tool_call', 'x');
    expect(rowFailed({ item: call, result: item('tool_result', 'x', {}, { status: 'error' }) })).toBe(true);
    expect(rowFailed({ item: item('tool_call', 'y', {}, { status: 'failed' }), result: null })).toBe(true);
    expect(rowFailed({ item: call, result: item('tool_result', 'x', { is_error: true }) })).toBe(true);
    expect(rowFailed({ item: call, result: item('tool_result', 'x', { success: false }) })).toBe(true);
  });

  it('does not flag a successful call and result', () => {
    expect(rowFailed({ item: item('tool_call', 'z'), result: item('tool_result', 'z', { is_error: false, success: true }) })).toBe(false);
    expect(rowFailed({ item: item('assistant_message', 'm'), result: null })).toBe(false);
  });
});

describe('row content', () => {
  it('shows a Claude tool call as its tool and command, with the result as its body', () => {
    const call = item('tool_call', 'toolu_c', { tool_name: 'Bash', input: { command: 'git status', description: 'Show status' } });
    const result = item('tool_result', 'toolu_c', { content: 'nothing to commit', is_error: false });
    const [row] = buildLiveStreamRows([call, result]);
    expect(rowLabel(row.item)).toBe('Bash');
    expect(toolArgument(row.item)).toBe('git status');
    expect(rowBody(row)).toBe('nothing to commit');
  });

  it('reads a Codex result from its output field', () => {
    const call = item('tool_call', 'exec-9:decision', { tool_name: 'exec_command', call_id: 'exec-9', input: null, arguments: '{"cmd":["ls","-la"]}' });
    const result = item('tool_result', 'exec-9:result', { tool_name: 'exec_command', call_id: 'exec-9', output: 'total 8' });
    const [row] = buildLiveStreamRows([call, result]);
    expect(toolArgument(row.item)).toBe('ls -la');
    expect(rowBody(row)).toBe('total 8');
  });

  it('shows no argument for redacted input and says the payload was redacted', () => {
    const call = item('tool_call', 'toolu_r', { tool_name: 'Bash', input: { redacted: true }, input_redacted: true });
    expect(toolArgument(call)).toBeNull();
    const thought = item('reasoning', 'm:r', { redacted: true, reason: 'reasoning_capture_disabled' });
    expect(rowBody({ item: thought, result: null })).toBe('Redacted by capture settings');
  });

  it('reduces a Codex model response row to its model and tokens', () => {
    const response = item('assistant_message', 'codex-event:1', { summary: 'Model response', model: 'gpt-6-astra', tokens_in: 13024, tokens_out: 210 });
    expect(rowLabel(response)).toBe('Model response');
    expect(rowBody({ item: response, result: null })).toBe('gpt-6-astra · 13.0K in · 210 out');
  });

  it('labels messages and thinking by who produced them', () => {
    expect(rowLabel(item('user_message', 'm:u', { text: 'hi' }))).toBe('You');
    expect(rowLabel(item('assistant_message', 'm:a', { text: 'hello' }))).toBe('Assistant');
    expect(rowLabel(item('reasoning', 'm:t', { text: 'plan' }))).toBe('Thinking');
    expect(rowBody({ item: item('reasoning', 'm:t', { text: 'plan it' }), result: null })).toBe('plan it');
  });

  it('reads a local slash command and its output instead of the raw tags', () => {
    const command = item('user_message', 'm:c', { text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' });
    const output = item('user_message', 'm:o', { text: '<local-command-stdout>Set model to Opus 5</local-command-stdout>' });
    const caveat = item('user_message', 'm:v', { text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' });
    expect([rowLabel(command), rowBody({ item: command, result: null })]).toEqual(['Command', '/model']);
    expect([rowLabel(output), rowBody({ item: output, result: null })]).toEqual(['Command output', 'Set model to Opus 5']);
    expect([rowLabel(caveat), rowBody({ item: caveat, result: null })]).toEqual(['Command note', null]);
  });
});
