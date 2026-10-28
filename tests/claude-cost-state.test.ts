import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-claude-cost-state-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { insertEvent } = await import('../src/db/queries.js');
const { readLatestCostState, checkClaudeTranscriptCosts } = await import('../src/import/claude-cost-state.js');

const claudeDir = path.join(tempDir, 'claude');
const projectDir = path.join(claudeDir, 'projects', '-tmp-cost-state-fixture');
const SESSION = '11111111-2222-4333-8444-555555555555';
const BARE = '11111111-2222-4333-8444-666666666666';

type Line = Record<string, unknown>;
const assistant = (timestamp: string, model?: string): Line => ({
  type: 'assistant', timestamp, sessionId: SESSION,
  message: { id: `msg-${timestamp}`, ...(model ? { model, usage: { input_tokens: 1, output_tokens: 1 } } : {}) },
});
const modelUsage = (costUSD: number) => ({
  inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD,
});
const costState = (opus: number, haiku: number, startTime = Date.parse('2026-10-20T00:00:00.000Z')): Line => ({
  type: 'cost-state', sessionId: SESSION, totalCostUSD: opus + haiku, startTime,
  modelUsage: { 'claude-opus-5-5': modelUsage(opus), 'claude-haiku-4-5-20251001': modelUsage(haiku) },
});
const text = (lines: Line[]) => lines.map(line => JSON.stringify(line)).join('\n');

function importedCost(model: string, cost: number, at: string, id: string): void {
  insertEvent({
    event_id: id, session_id: SESSION, agent_type: 'claude_code', event_type: 'llm_response', status: 'success',
    tokens_in: 10, tokens_out: 20, model, cost_usd: cost, source: 'import', client_timestamp: at, metadata: null,
  });
}

describe('readLatestCostState', () => {
  test('reads the last checkpoint and cuts it at the timestamped line before it', () => {
    const checkpoint = readLatestCostState(text([
      assistant('2026-10-20T10:00:00.000Z'), costState(1, 0),
      assistant('2026-10-21T10:00:00.000Z'), { type: 'file-history-snapshot' }, costState(4, 0.5),
      assistant('2026-10-22T10:00:00.000Z'),
    ]));
    assert.ok(checkpoint);
    assert.equal(checkpoint.cut, '2026-10-21T10:00:00.000Z');
    assert.equal(checkpoint.since, '2026-10-20T00:00:00.000Z');
    assert.equal(checkpoint.total_cost_usd, 4.5);
    assert.deepEqual(checkpoint.models['claude-opus-5-5'], {
      cost_usd: 4, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40,
    });
  });

  test('a transcript without a checkpoint has none', () => {
    assert.equal(readLatestCostState(text([assistant('2026-10-20T10:00:00.000Z')])), null);
  });

  test('a checkpoint with nothing timestamped before it has no cut', () => {
    assert.equal(readLatestCostState(text([costState(1, 0), assistant('2026-10-20T10:00:00.000Z')]))?.cut, null);
  });
});

describe('checkClaudeTranscriptCosts', () => {
  before(() => {
    initSchema();
    assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
    fs.mkdirSync(projectDir, { recursive: true });
  });
  beforeEach(() => {
    const db = getDb();
    // Fail closed before the table-wide deletes if the handle is not the fixture's.
    assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
    db.exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM agents;');
    for (const entry of fs.readdirSync(projectDir)) fs.rmSync(path.join(projectDir, entry), { recursive: true, force: true });
  });
  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('compares each model up to the cut and names the models amon never saw', () => {
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-21T10:00:00.000Z'), costState(4, 0.5), assistant('2026-10-22T10:00:00.000Z'),
    ]));
    importedCost('claude-opus-5-5', 3, '2026-10-21T09:00:00.000Z', 'before-cut');
    importedCost('claude-opus-5-5', 50, '2026-10-22T10:00:00.000Z', 'after-cut');

    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.equal(check.status, 'checked');
    assert.equal(check.cut, '2026-10-21T10:00:00.000Z');
    assert.equal(check.harness_cost_usd, 4.5);
    assert.equal(check.amon_cost_usd, 3, 'usage after the checkpoint is not compared with it');
    assert.equal(check.ratio, 3 / 4.5);
    const opus = check.models.find(m => m.model === 'claude-opus-5-5')!;
    assert.deepEqual({ model: opus.model, harness_cost_usd: opus.harness_cost_usd, amon_cost_usd: opus.amon_cost_usd, ratio: opus.ratio }, {
      model: 'claude-opus-5-5', harness_cost_usd: 4, amon_cost_usd: 3, ratio: 0.75,
    });
    assert.deepEqual(check.missing_models, ['claude-haiku-4-5-20251001']);
  });

  test('a checkpoint counts from its own process start: usage before a counter reset is not compared', () => {
    // A process that did not restore the session's cost state starts its
    // totals at zero, and its checkpoint carries that process's start.
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-21T10:00:00.000Z'), costState(90, 0),
      assistant('2026-10-23T10:00:00.000Z'), costState(4, 0, Date.parse('2026-10-23T09:00:00.000Z')),
    ]));
    importedCost('claude-opus-5-5', 90, '2026-10-21T09:00:00.000Z', 'earlier-process');
    importedCost('claude-opus-5-5', 3, '2026-10-23T09:30:00.000Z', 'this-process');
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.equal(check.since, '2026-10-23T09:00:00.000Z');
    assert.equal(check.amon_cost_usd, 3);
    assert.equal(check.ratio, 0.75);
  });

  test('a model the transcripts record but amon never imported is a coverage gap, not unrecorded usage', () => {
    fs.mkdirSync(path.join(projectDir, SESSION, 'subagents'), { recursive: true });
    // The Haiku request is in the session's own transcript; a subagent's model is in its own file.
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-21T09:00:00.000Z', 'claude-haiku-4-5-20251001'), assistant('2026-10-21T10:00:00.000Z'),
      { ...costState(4, 0.5), modelUsage: { ...(costState(4, 0.5).modelUsage as object), 'claude-sonnet-5': modelUsage(2) } },
    ]));
    fs.writeFileSync(path.join(projectDir, SESSION, 'subagents', 'agent-a1.jsonl'), text([assistant('2026-10-21T09:30:00.000Z', 'claude-sonnet-5')]));
    importedCost('claude-opus-5-5', 3, '2026-10-21T09:00:00.000Z', 'opus');

    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.deepEqual(check.unimported_models.sort(), ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
    assert.deepEqual(check.missing_models, []);
  });

  test('a model recorded only outside the checkpoint window is still unrecorded within it', () => {
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-19T09:00:00.000Z', 'claude-haiku-4-5-20251001'), assistant('2026-10-21T10:00:00.000Z'), costState(4, 0.5),
    ]));
    importedCost('claude-opus-5-5', 3, '2026-10-21T09:00:00.000Z', 'opus');
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.deepEqual(check.missing_models, ['claude-haiku-4-5-20251001']);
    assert.deepEqual(check.unimported_models, []);
  });

  test('a transcript without a checkpoint is reported as such, with no ratio', () => {
    fs.writeFileSync(path.join(projectDir, `${BARE}.jsonl`), text([assistant('2026-10-21T10:00:00.000Z')]));
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.equal(check.session_id, BARE);
    assert.equal(check.status, 'no_checkpoint');
    assert.equal(check.ratio, null);
    assert.equal(check.harness_cost_usd, null);
  });

  test('an unpriced imported row withholds the ratio rather than reading low', () => {
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([assistant('2026-10-21T10:00:00.000Z'), costState(4, 0)]));
    importedCost('claude-opus-5-5', 3, '2026-10-21T09:00:00.000Z', 'priced');
    insertEvent({
      event_id: 'unpriced', session_id: SESSION, agent_type: 'claude_code', event_type: 'llm_response', status: 'success',
      tokens_in: 10, tokens_out: 20, model: 'claude-unknown-9', cost_usd: null, source: 'import',
      client_timestamp: '2026-10-21T09:30:00.000Z', metadata: null,
    });
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    assert.equal(check.unpriced_rows, 1);
    assert.equal(check.ratio, null);
  });

  // The harness's own tokens priced at amon's rates separate usage amon does not
  // hold (coverage) from a disagreement about what a token costs (rate_ratio).
  const usageLine = (model: string, u: { cr: number; cw: number; cost: number }): Line => ({
    type: 'cost-state', sessionId: SESSION, totalCostUSD: u.cost, startTime: Date.parse('2026-10-20T00:00:00.000Z'),
    modelUsage: { [model]: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: u.cr, cacheCreationInputTokens: u.cw, costUSD: u.cost } },
  });
  const importedUsage = (model: string, u: { cr: number; cw: number; cw1h: number; cost: number }, id: string) => insertEvent({
    event_id: id, session_id: SESSION, agent_type: 'claude_code', event_type: 'llm_response', status: 'success',
    tokens_in: 0, tokens_out: 0, cache_read_tokens: u.cr, cache_write_tokens: u.cw, cache_write_1h_tokens: u.cw1h,
    model, cost_usd: u.cost, source: 'import', client_timestamp: '2026-10-21T09:00:00.000Z', metadata: null,
  });
  const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

  test('a harness that bills more per token reads as a rate disagreement, not missing usage', () => {
    // Sonnet 5.5 cache reads: the pricing page's $0.10/MTok, which Claude Code bills at $0.20.
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-21T10:00:00.000Z'), usageLine('claude-sonnet-5-5', { cr: 1_000_000, cw: 0, cost: 0.2 }),
    ]));
    importedUsage('claude-sonnet-5-5', { cr: 1_000_000, cw: 0, cw1h: 0, cost: 0.1 }, 'sonnet');
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    const sonnet = check.models[0];
    assert.ok(close(sonnet.ratio, 0.5));
    assert.ok(close(sonnet.harness_tokens_cost_usd, 0.1));
    assert.ok(close(sonnet.coverage, 1), `coverage ${sonnet.coverage}`);
    assert.ok(close(sonnet.rate_ratio, 0.5), `rate ${sonnet.rate_ratio}`);
    assert.ok(close(check.coverage, 1));
    assert.ok(close(check.rate_ratio, 0.5));
  });

  test('usage amon does not hold reads as coverage below 1, cache writes at the rate amon stored them', () => {
    // Opus 5.5: cache read $0.20, 1-hour cache write $8 per MTok. amon holds
    // half the reads; its cache writes are all 1-hour, so the harness's are priced so.
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([
      assistant('2026-10-21T10:00:00.000Z'), usageLine('claude-opus-5-5', { cr: 2_000_000, cw: 100_000, cost: 1.2 }),
    ]));
    importedUsage('claude-opus-5-5', { cr: 1_000_000, cw: 100_000, cw1h: 100_000, cost: 1 }, 'opus');
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    const opus = check.models[0];
    assert.ok(close(opus.harness_tokens_cost_usd, 1.2), `priced ${opus.harness_tokens_cost_usd}`);
    assert.ok(close(opus.coverage, 1 / 1.2), `coverage ${opus.coverage}`);
    assert.ok(close(opus.rate_ratio, 1), `rate ${opus.rate_ratio}`);
  });

  test('a model amon cannot price has no coverage, and neither does its session', () => {
    const line = usageLine('claude-sonnet-5-5', { cr: 1_000_000, cw: 0, cost: 0.1 });
    const usage = line.modelUsage as Record<string, unknown>;
    usage['claude-unknown-9'] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0, costUSD: 1 };
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([assistant('2026-10-21T10:00:00.000Z'), { ...line, totalCostUSD: 1.1 }]));
    importedUsage('claude-sonnet-5-5', { cr: 1_000_000, cw: 0, cw1h: 0, cost: 0.1 }, 'sonnet');
    const [check] = checkClaudeTranscriptCosts({ claudeDir });
    const unknown = check.models.find(m => m.model === 'claude-unknown-9')!;
    assert.equal(unknown.coverage, null);
    assert.equal(unknown.rate_ratio, null);
    assert.ok(close(check.models.find(m => m.model === 'claude-sonnet-5-5')!.coverage, 1));
    assert.equal(check.coverage, null, 'the priced model alone is not the session');
    assert.equal(check.rate_ratio, null);
  });

  test('subagent transcripts are not sessions of their own', () => {
    fs.mkdirSync(path.join(projectDir, SESSION, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, SESSION, 'subagents', 'agent-a1.jsonl'), text([assistant('2026-10-21T10:00:00.000Z')]));
    // Older Claude Code versions kept subagent transcripts beside the session.
    fs.writeFileSync(path.join(projectDir, 'agent-a2.jsonl'), text([assistant('2026-10-21T10:00:00.000Z')]));
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([assistant('2026-10-21T10:00:00.000Z'), costState(4, 0)]));
    assert.deepEqual(checkClaudeTranscriptCosts({ claudeDir }).map(check => check.session_id), [SESSION]);
  });
});
