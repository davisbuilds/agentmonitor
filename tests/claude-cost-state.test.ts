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
const assistant = (timestamp: string): Line => ({ type: 'assistant', timestamp, sessionId: SESSION, message: { id: `msg-${timestamp}` } });
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
    getDb().exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM agents;');
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
    assert.deepEqual(check.models.find(m => m.model === 'claude-opus-5-5'), {
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

  test('subagent transcripts are not sessions of their own', () => {
    fs.mkdirSync(path.join(projectDir, SESSION, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, SESSION, 'subagents', 'agent-a1.jsonl'), text([assistant('2026-10-21T10:00:00.000Z')]));
    // Older Claude Code versions kept subagent transcripts beside the session.
    fs.writeFileSync(path.join(projectDir, 'agent-a2.jsonl'), text([assistant('2026-10-21T10:00:00.000Z')]));
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), text([assistant('2026-10-21T10:00:00.000Z'), costState(4, 0)]));
    assert.deepEqual(checkClaudeTranscriptCosts({ claudeDir }).map(check => check.session_id), [SESSION]);
  });
});
