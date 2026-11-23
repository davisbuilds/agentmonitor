import fs from 'node:fs';
import path from 'node:path';

const sessionId = '01a20000-0000-7000-8000-000000000041';
const continuationId = '01a20000-0000-7000-8000-000000000042';
const replacementId = '01a20000-0000-7000-8000-000000000043';
const model = 'gpt-5.6-terra';
const cwd = '/synthetic/accounting-replay';

type Usage = { input: number; cached: number; output: number };
type Request = Usage & { timestamp: string; prompt: string; answer: string; responseId?: string };
type RolloutRecord = { type: string; timestamp: string; payload: Record<string, unknown> };

export const nativeRequests = [
  { timestamp: '2026-11-08T10:01:00Z', input: 200_000, cached: 100_000, output: 2_000,
    prompt: 'Outline a café menu.', answer: 'Start with a small breakfast menu.' },
  { timestamp: '2026-11-09T10:01:00Z', input: 5_000, cached: 2_000, output: 50,
    prompt: 'Add a dessert.', answer: 'Add an apple tart.' },
  { timestamp: '2026-11-10T10:01:00Z', input: 1_000, cached: 400, output: 10,
    prompt: 'Suggest a drink instead.', answer: 'Serve mint tea.', responseId: 'resp_synthetic_mint_tea' },
  { timestamp: '2026-11-11T10:01:00Z', input: 2_000, cached: 1_200, output: 20,
    prompt: 'Summarize the revised menu.', answer: 'Breakfast and mint tea.', responseId: 'resp_synthetic_menu' },
] as const satisfies readonly Request[];

function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

function nativeUsage(usage: Usage) {
  return {
    input_tokens: usage.input, cached_input_tokens: usage.cached, output_tokens: usage.output,
    reasoning_output_tokens: 0, total_tokens: usage.input + usage.output,
  };
}

function counter(timestamp: string, total: Usage, last: Usage): RolloutRecord {
  return { type: 'event_msg', timestamp, payload: {
    type: 'token_count', info: { total_token_usage: nativeUsage(total), last_token_usage: nativeUsage(last) },
  } };
}

function requestRecords(request: Request, total: Usage): RolloutRecord[] {
  const day = request.timestamp.slice(0, 10);
  const records: RolloutRecord[] = [
    { type: 'turn_context', timestamp: `${day}T10:00:10Z`, payload: { cwd, model } },
    { type: 'response_item', timestamp: `${day}T10:00:11Z`, payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: request.prompt }],
    } },
  ];
  if (request.responseId) records.push({ type: 'token_usage_record', timestamp: request.timestamp, payload: {
    response_id: request.responseId, thread_id: sessionId, usage: nativeUsage(request), thread_token_usage: nativeUsage(total),
  } });
  records.push(counter(request.timestamp, total, request), {
    type: 'response_item', timestamp: `${day}T10:01:01Z`, payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: request.answer }],
    },
  });
  return records;
}

function sessionMeta(day: string, historyMode: 'full' | 'paginated', historyBase?: {
  thread_id: string; end_byte_offset: number; end_ordinal_exclusive: number;
}): RolloutRecord {
  return { type: 'session_meta', timestamp: `${day}T10:00:00Z`, payload: {
    id: sessionId, cwd, source: 'cli', originator: 'codex_cli_rs', timestamp: '2026-11-08T10:00:00Z',
    history_mode: historyMode, ...(historyBase ? { history_base: historyBase } : {}),
  } };
}

function jsonl(records: readonly RolloutRecord[], startOrdinal = 0): string {
  return records.map((record, index) => JSON.stringify({ ordinal: startOrdinal + index, ...record })).join('\n') + '\n';
}

function write(codexDir: string, day: string, physicalId: string, body: string): void {
  const file = path.join(codexDir, 'sessions', ...day.split('-'), `rollout-${day}T10-00-00-${physicalId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function writeCodexAccountingReplay(codexDir: string, layout: 'full' | 'split'): void {
  const [retained, reverted, resumed, appended] = nativeRequests;
  const [rootDay, continuationDay, replacementDay] = [retained, resumed, appended].map(request => request.timestamp.slice(0, 10));
  const prefix = requestRecords(retained, retained);
  const originalTotal = addUsage(retained, reverted);
  const originalSuffix = requestRecords(reverted, originalTotal);
  if (layout === 'full') {
    const resumedTotal = addUsage(originalTotal, resumed);
    write(codexDir, rootDay, sessionId, jsonl([
      sessionMeta(rootDay, 'full'), ...prefix, ...originalSuffix,
      ...requestRecords(resumed, resumedTotal), ...requestRecords(appended, addUsage(resumedTotal, appended)),
    ]));
    return;
  }

  const rootPrefix = [sessionMeta(rootDay, 'paginated'), ...prefix];
  write(codexDir, rootDay, sessionId, jsonl([...rootPrefix, ...originalSuffix]));
  const historyBase = {
    thread_id: sessionId, end_byte_offset: Buffer.byteLength(jsonl(rootPrefix)), end_ordinal_exclusive: rootPrefix.length,
  };
  const resumedTotal = addUsage(retained, resumed);
  const continuationSuffix = [counter(`${continuationDay}T10:00:05Z`, retained, retained), ...requestRecords(resumed, resumedTotal)];
  write(codexDir, continuationDay, continuationId, jsonl([
    sessionMeta(continuationDay, 'paginated', historyBase), ...continuationSuffix,
  ], historyBase.end_ordinal_exclusive));
  write(codexDir, replacementDay, replacementId, jsonl([
    sessionMeta(replacementDay, 'full'), ...prefix, ...continuationSuffix,
    ...requestRecords(appended, addUsage(resumedTotal, appended)),
  ]));
}
