import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-total-check-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { runImport } = await import('../src/import/index.js');
const { checkSessionTotals } = await import('../src/import/session-total-check.js');

const claudeDir = path.join(tempDir, 'claude');
const claudeProject = path.join(claudeDir, 'projects', '-tmp-session-total-fixture');
const codexDir = path.join(tempDir, 'codex');
const codexSessions = path.join(codexDir, 'sessions', '2026', '10', '27');

type Line = Record<string, unknown>;
const jsonl = (lines: Line[]) => lines.map(line => JSON.stringify(line)).join('\n');

// ─── Codex fixtures ─────────────────────────────────────────────────────
const PER_REQUEST = '019f2222-0000-7000-8000-000000000001';
const LEGACY = '019f2222-0000-7000-8000-000000000002';
const UNIMPORTED = '019f2222-0000-7000-8000-000000000003';
const at = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, '0')}:00Z`;
const meta = (id: string): Line => ({ type: 'session_meta', timestamp: at(0), payload: { id, cwd: '/tmp/session-total-fixture', source: 'cli' } });
const turn: Line = { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5.6-terra' } };
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const counter = (minute: number, input: number, cached: number, output: number): Line => ({
  type: 'event_msg', timestamp: at(minute), payload: { type: 'token_count', info: { total_token_usage: usage(input, cached, output) } },
});
const record = (minute: number, id: string, responseId: string, own: number[], thread: number[]): Line => ({
  type: 'token_usage_record', timestamp: at(minute),
  payload: { thread_id: id, response_id: responseId, usage: usage(own[0], own[1], own[2]), thread_token_usage: usage(thread[0], thread[1], thread[2]) },
});
const perRequestRollout = (id: string): Line[] => [
  meta(id), turn,
  record(1, id, 'resp-1', [1_000, 800, 50], [1_000, 800, 50]), counter(1, 1_000, 800, 50),
  record(2, id, 'resp-2', [2_000, 1_500, 70], [3_000, 2_300, 120]), counter(2, 3_000, 2_300, 120),
];
const writeRollout = (id: string, lines: Line[]) =>
  fs.writeFileSync(path.join(codexSessions, `rollout-2026-10-27T10-00-00-${id}.jsonl`), jsonl(lines));

// ─── Claude fixtures ────────────────────────────────────────────────────
const CLAUDE = '11111111-2222-4333-8444-777777777777';
const assistant = (timestamp: string): Line => ({ type: 'assistant', timestamp, sessionId: CLAUDE, message: { id: `msg-${timestamp}` } });
const costState: Line = {
  type: 'cost-state', sessionId: CLAUDE, totalCostUSD: 4, startTime: Date.parse('2026-10-27T00:00:00.000Z'),
  modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 4 } },
};

before(() => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
});
beforeEach(() => {
  // Fail closed before the table-wide deletes if the handle is not the fixture's.
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  getDb().exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM agents; DELETE FROM import_state;');
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.mkdirSync(claudeProject, { recursive: true });
  fs.mkdirSync(codexSessions, { recursive: true });
});
after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const check = (source: 'claude-code' | 'codex' | 'antigravity' | 'all') => checkSessionTotals({ source, claudeDir, codexDir });
const codexRow = (report: ReturnType<typeof check>, id: string) => report.sessions.find(row => row.source === 'codex' && row.session_id === id);

test('a Codex session is checked against its thread total, in tokens', () => {
  writeRollout(PER_REQUEST, perRequestRollout(PER_REQUEST));
  runImport({ source: 'codex', codexDir });
  const report = check('codex');
  assert.deepEqual(codexRow(report, PER_REQUEST), {
    source: 'codex', session_id: PER_REQUEST, status: 'checked', harness: 3_000 + 120, amon: 3_000 + 120, ratio: 1,
  });
  assert.deepEqual(report.sources.codex, {
    instrument: 'codex_thread_total', unit: 'tokens', sessions: 1, checked: 1, ratio_min: 1, ratio_median: 1, ratio_max: 1,
  });
});

test('stored Codex usage that falls short of the thread total reads below 1', () => {
  writeRollout(PER_REQUEST, perRequestRollout(PER_REQUEST));
  runImport({ source: 'codex', codexDir });
  getDb().prepare(`DELETE FROM events WHERE session_id = ? AND event_type = 'llm_response' AND tokens_out = 70`).run(PER_REQUEST);
  const row = codexRow(check('codex'), PER_REQUEST)!;
  assert.equal(row.status, 'checked');
  assert.equal(row.amon, 1_000 + 50);
  assert.equal(row.ratio, (1_000 + 50) / (3_000 + 120));
});

test('the check reads the thread total, not the cumulative counter', () => {
  // A request the counter left out: the thread total holds it, so a session
  // billed only to the counter would read below 1.
  writeRollout(PER_REQUEST, [...perRequestRollout(PER_REQUEST), record(3, PER_REQUEST, 'resp-3', [500, 0, 5], [3_500, 2_300, 125])]);
  runImport({ source: 'codex', codexDir });
  const row = codexRow(check('codex'), PER_REQUEST)!;
  assert.equal(row.harness, 3_500 + 125);
  assert.equal(row.ratio, 1);
});

test('a Codex rollout without a thread total, or not imported, is named and not compared', () => {
  writeRollout(LEGACY, [meta(LEGACY), turn, counter(1, 1_000, 800, 50)]);
  writeRollout(UNIMPORTED, perRequestRollout(UNIMPORTED));
  runImport({ source: 'codex', codexDir });
  getDb().prepare('DELETE FROM events WHERE session_id = ?').run(UNIMPORTED);
  const report = check('codex');
  assert.equal(codexRow(report, LEGACY)?.status, 'no_thread_total');
  assert.equal(codexRow(report, UNIMPORTED)?.status, 'not_imported');
  assert.equal(codexRow(report, UNIMPORTED)?.ratio, null);
  assert.equal(report.sources.codex?.checked, 0);
  assert.equal(report.sources.codex?.ratio_median, null);
});

test('a Claude session is checked against its cost-state checkpoint, in dollars', () => {
  fs.writeFileSync(path.join(claudeProject, `${CLAUDE}.jsonl`), jsonl([assistant('2026-10-27T10:00:00.000Z'), costState]));
  insertEvent({
    event_id: 'cc-1', session_id: CLAUDE, agent_type: 'claude_code', event_type: 'llm_response', status: 'success',
    tokens_in: 1, tokens_out: 1, model: 'claude-opus-5-5', cost_usd: 3, source: 'import', client_timestamp: '2026-10-27T09:00:00.000Z', metadata: null,
  });
  const report = check('claude-code');
  const row = report.sessions.find(r => r.source === 'claude-code')!;
  assert.equal(row.session_id, CLAUDE);
  assert.equal(row.status, 'checked');
  assert.equal(row.harness, 4);
  assert.equal(row.amon, 3);
  assert.equal(row.ratio, 0.75);
  assert.ok(row.detail && Array.isArray(row.detail.models), 'the per-model split is kept');
  assert.equal(report.sources['claude-code']?.instrument, 'claude_cost_state');
  assert.equal(report.sources['claude-code']?.unit, 'usd');
});

test('a Claude session reports its coverage apart from a disagreement in rates', () => {
  // Every token imported, but the harness bills Sonnet 5.5 cache reads at twice amon's rate.
  const line: Line = {
    type: 'cost-state', sessionId: CLAUDE, totalCostUSD: 0.2, startTime: Date.parse('2026-10-27T00:00:00.000Z'),
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0, costUSD: 0.2 } },
  };
  fs.writeFileSync(path.join(claudeProject, `${CLAUDE}.jsonl`), jsonl([assistant('2026-10-27T10:00:00.000Z'), line]));
  insertEvent({
    event_id: 'cc-sonnet', session_id: CLAUDE, agent_type: 'claude_code', event_type: 'llm_response', status: 'success',
    tokens_in: 0, tokens_out: 0, cache_read_tokens: 1_000_000, model: 'claude-sonnet-5-5', cost_usd: 0.1, source: 'import',
    client_timestamp: '2026-10-27T09:00:00.000Z', metadata: null,
  });
  const report = check('claude-code');
  const row = report.sessions.find(r => r.source === 'claude-code')!;
  assert.equal(row.ratio, 0.5);
  assert.equal(row.detail?.coverage, 1);
  assert.equal(row.detail?.rate_ratio, 0.5);
  const summary = report.sources['claude-code']!;
  assert.equal(summary.ratio_median, 0.5);
  assert.deepEqual([summary.coverage_min, summary.coverage_median, summary.coverage_max], [1, 1, 1]);
});

test('Antigravity is reported as having no instrument, not as matching', () => {
  const report = check('antigravity');
  assert.deepEqual(report.sources.antigravity, {
    instrument: null, unit: null, sessions: 0, checked: 0, ratio_min: null, ratio_median: null, ratio_max: null,
  });
  assert.deepEqual(report.sessions, []);
});

test('all sources are reported together, and one source is reported alone', () => {
  writeRollout(PER_REQUEST, perRequestRollout(PER_REQUEST));
  runImport({ source: 'codex', codexDir });
  assert.deepEqual(Object.keys(check('all').sources).sort(), ['antigravity', 'claude-code', 'codex']);
  assert.deepEqual(Object.keys(check('codex').sources), ['codex']);
});

test('another thread\'s record in the rollout is not this session\'s total', () => {
  writeRollout(PER_REQUEST, [...perRequestRollout(PER_REQUEST), record(3, 'another-thread', 'resp-x', [9, 9, 9], [99_999, 0, 9])]);
  runImport({ source: 'codex', codexDir });
  assert.equal(codexRow(check('codex'), PER_REQUEST)?.harness, 3_000 + 120);
});

test('the summary spans the checked ratios, with the median of an even count halfway', () => {
  writeRollout(PER_REQUEST, perRequestRollout(PER_REQUEST));
  writeRollout(UNIMPORTED, perRequestRollout(UNIMPORTED));
  runImport({ source: 'codex', codexDir });
  // Half of one session's usage goes missing: 1050 of 3120 tokens.
  getDb().prepare(`DELETE FROM events WHERE session_id = ? AND event_type = 'llm_response' AND tokens_out = 70`).run(UNIMPORTED);
  const short = (1_000 + 50) / (3_000 + 120);
  assert.deepEqual(check('codex').sources.codex, {
    instrument: 'codex_thread_total', unit: 'tokens', sessions: 2, checked: 2, ratio_min: short, ratio_median: (short + 1) / 2, ratio_max: 1,
  });
});

test('the limit keeps the most recently written rollouts', () => {
  writeRollout(PER_REQUEST, perRequestRollout(PER_REQUEST));
  writeRollout(LEGACY, [meta(LEGACY), turn, counter(1, 1_000, 800, 50)]);
  const older = new Date('2026-10-01T00:00:00Z');
  fs.utimesSync(path.join(codexSessions, `rollout-2026-10-27T10-00-00-${PER_REQUEST}.jsonl`), older, older);
  runImport({ source: 'codex', codexDir });
  const report = checkSessionTotals({ source: 'codex', claudeDir, codexDir, limit: 1 });
  assert.deepEqual(report.sessions.map(row => row.session_id), [LEGACY]);
});
