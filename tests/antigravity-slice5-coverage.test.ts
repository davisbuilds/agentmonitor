import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before, beforeEach } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';

import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { initSchema as initSchemaFn } from '../src/db/schema.js';
import type { runImport as runImportFn } from '../src/import/index.js';
import type { repairAntigravityImportUsage as repairAgrFn } from '../src/import/antigravity-usage-repair.js';
import type { recalculateEventCosts as recalcFn } from '../src/pricing/recalc.js';
import type {
  deriveSessionTraceSummary as deriveSummaryFn,
  maintainSessionTraceSummary as maintainSummaryFn,
  sessionTraceId as sessionTraceIdFn,
} from '../src/trace-quality/summary.js';
import type { listWarehouseSessionTraceSummaries as listWarehouseFn } from '../src/warehouse/source.js';
import type {
  assertContentFree as assertContentFreeFn,
  mapSummaryToRunRow as mapSummaryToRunRowFn,
} from '../src/warehouse/runs-export.js';
import type { planRuns as planRunsFn } from '../src/warehouse/postgres-sink.js';
import type { syncAllAntigravityFiles as syncAllAgrFn } from '../src/watcher/index.js';
import type { main as cliMainFn } from '../src/cli.js';
import type { WarehouseRunRow } from '../src/warehouse/types.js';

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);
const buf = (a: number[]) => Buffer.from(a);

function buildStepPayload(stepType: number, oneofField: number, status = 3, inner: number[] = vField(1, 1)): Buffer {
  return buf([...vField(1, stepType), ...vField(4, status), ...lField(5, vField(1, 1)), ...lField(oneofField, inner)]);
}

function buildStepMeta(secs: number): Buffer {
  return buf(lField(1, vField(1, secs)));
}

function buildGenBlob(opts: {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
  modelEnum?: number;
  createdAtSecs?: number;
  messageId?: string;
}): Buffer {
  const usageFields = [
    ...(opts.modelEnum !== undefined ? vField(1, opts.modelEnum) : []),
    ...vField(2, opts.input),
    ...vField(3, opts.output),
    ...(opts.cacheWrite !== undefined ? vField(4, opts.cacheWrite) : []),
    ...(opts.cacheRead !== undefined ? vField(5, opts.cacheRead) : []),
    ...(opts.messageId ? sField(7, opts.messageId) : []),
    ...(opts.thinking !== undefined ? vField(9, opts.thinking) : []),
  ];
  const chatStart = opts.createdAtSecs !== undefined
    ? lField(9, lField(4, vField(1, opts.createdAtSecs)))
    : [];
  const gm = [
    ...lField(4, usageFields),
    ...chatStart,
    ...sField(19, opts.model),
  ];
  return buf(lField(1, gm));
}

function writeConversationDb(
  homeDir: string,
  sessionId: string,
  config: {
    steps?: Array<{ idx: number; stepType: number; oneof: number; status?: number; secs?: number }>;
    gens?: Array<{ idx: number; blob: Buffer }>;
    transcriptLines?: unknown[];
  },
): string {
  const convDir = path.join(homeDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${sessionId}.db`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');
  const insStep = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const step of config.steps ?? []) {
    const status = step.status ?? 3;
    insStep.run(
      step.idx,
      step.stepType,
      status,
      buildStepPayload(step.stepType, step.oneof, status),
      step.secs !== undefined ? buildStepMeta(step.secs) : null,
    );
  }
  const insGen = db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  for (const gen of config.gens ?? []) {
    insGen.run(gen.idx, gen.blob);
  }
  db.close();

  if (config.transcriptLines) {
    const logsDir = path.join(homeDir, 'brain', sessionId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      `${config.transcriptLines.map(line => JSON.stringify(line)).join('\n')}\n`,
    );
  }
  return dbPath;
}

class CaptureStream extends Writable {
  output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

let tempDir = '';
let dbPath = '';
let agrHome = '';
let claudeDir = '';
let codexHome = '';
let server: Server;
let baseUrl = '';

let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let initSchema: typeof initSchemaFn;
let runImport: typeof runImportFn;
let repairAntigravityImportUsage: typeof repairAgrFn;
let recalculateEventCosts: typeof recalcFn;
let deriveSessionTraceSummary: typeof deriveSummaryFn;
let maintainSessionTraceSummary: typeof maintainSummaryFn;
let sessionTraceId: typeof sessionTraceIdFn;
let listWarehouseSessionTraceSummaries: typeof listWarehouseFn;
let mapSummaryToRunRow: typeof mapSummaryToRunRowFn;
let assertContentFree: typeof assertContentFreeFn;
let planRuns: typeof planRunsFn;
let syncAllAntigravityFiles: typeof syncAllAgrFn;
let cliMain: typeof cliMainFn;

async function runCli(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await cliMain(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

async function getJson<T>(urlPath: string): Promise<T> {
  const response = await fetch(`${baseUrl}${urlPath}`);
  if (response.status !== 200) {
    assert.equal(response.status, 200, await response.text());
  }
  return response.json() as Promise<T>;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-slice5-'));
  dbPath = path.join(tempDir, 'agentmonitor.db');
  agrHome = path.join(tempDir, 'antigravity-cli');
  claudeDir = path.join(tempDir, 'claude');
  codexHome = path.join(tempDir, 'codex');
  fs.mkdirSync(path.join(agrHome, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  process.env.AGENTMONITOR_DB_PATH = dbPath;

  const conn = await import('../src/db/connection.js');
  getDb = conn.getDb;
  closeDb = conn.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ runImport } = await import('../src/import/index.js'));
  ({ repairAntigravityImportUsage } = await import('../src/import/antigravity-usage-repair.js'));
  ({ recalculateEventCosts } = await import('../src/pricing/recalc.js'));
  ({
    deriveSessionTraceSummary,
    maintainSessionTraceSummary,
    sessionTraceId,
  } = await import('../src/trace-quality/summary.js'));
  ({ listWarehouseSessionTraceSummaries } = await import('../src/warehouse/source.js'));
  ({ mapSummaryToRunRow, assertContentFree } = await import('../src/warehouse/runs-export.js'));
  ({ planRuns } = await import('../src/warehouse/postgres-sink.js'));
  ({ syncAllAntigravityFiles } = await import('../src/watcher/index.js'));
  ({ main: cliMain } = await import('../src/cli.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(dbPath));

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(dbPath));
  db.exec(`
    DELETE FROM session_trace_summary;
    DELETE FROM session_items;
    DELETE FROM session_turns;
    DELETE FROM tool_calls;
    DELETE FROM messages;
    DELETE FROM browsing_sessions;
    DELETE FROM watched_files;
    DELETE FROM import_state;
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM agents;
  `);
  for (const name of fs.readdirSync(agrHome)) {
    fs.rmSync(path.join(agrHome, name), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(agrHome, 'conversations'), { recursive: true });
});

test('all-zero measured usage is distinguished from missing/unavailable usage in v2 and warehouse export', async () => {
  const zeroId = 'agr-zero-usage-001';
  const legacyId = 'agr-summary-only-001';
  const usageOnlyId = 'agr-usage-only-001';
  const t0 = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);

  writeConversationDb(agrHome, zeroId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 }],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-4-neon',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        createdAtSecs: t0 + 1,
        messageId: 'zero-msg-1',
      }),
    }],
  });

  writeConversationDb(agrHome, legacyId, {
    steps: [
      { idx: 0, stepType: 14, oneof: 19, secs: t0 + 10 },
      { idx: 1, stepType: 28, oneof: 28, secs: t0 + 15 },
    ],
    gens: [],
  });

  const db = getDb();
  syncAllAntigravityFiles(db, agrHome, { force: true });

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, model,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
      cost_usd, cost_source, source, client_timestamp, metadata
    ) VALUES (?, ?, 'antigravity', 'llm_response', 'success', 'gemini-4-neon', 1000, 200, 0, 0, 0.006, 'estimated', 'import', '2026-11-26T10:05:00.000Z', ?)
  `).run('import-agr-usage-only-1', usageOnlyId, JSON.stringify({ _source: 'antigravity_db', timestamp_source: 'generation_created_at' }));
  maintainSessionTraceSummary(usageOnlyId, db);

  const zeroSummary = deriveSessionTraceSummary(zeroId, db);
  assert.equal(zeroSummary.coverage.usage_coverage, 'observed_zero');
  assert.equal(zeroSummary.coverage.has_token_usage, true);
  assert.equal(zeroSummary.coverage.cost_coverage, 'priced');
  assert.equal(zeroSummary.coverage.cost_provenance, 'estimated');
  assert.equal(zeroSummary.coverage.has_cost, true);
  assert.equal(zeroSummary.coverage.timestamp_coverage, 'exact');

  const legacySummary = deriveSessionTraceSummary(legacyId, db);
  assert.equal(legacySummary.coverage.usage_coverage, 'unavailable');
  assert.equal(legacySummary.coverage.has_token_usage, false);
  assert.equal(legacySummary.coverage.cost_coverage, 'unavailable');
  assert.equal(legacySummary.coverage.cost_provenance, 'unavailable');
  assert.equal(legacySummary.coverage.has_cost, false);
  assert.equal(legacySummary.coverage.has_full_transcript, false);

  const usageOnlySummary = deriveSessionTraceSummary(usageOnlyId, db);
  assert.equal(usageOnlySummary.coverage.usage_coverage, 'observed');
  assert.equal(usageOnlySummary.coverage.has_full_transcript, false);

  const v2Traces = await getJson<{
    data: Array<{ session_id: string; coverage: Record<string, unknown> }>;
    coverage: {
      usage_coverage_breakdown: { observed: number; observed_zero: number; unavailable: number };
      cost_coverage_breakdown: { priced: number; partial: number; unpriced: number; unavailable: number };
    };
  }>('/api/v2/trace-quality/traces');

  assert.deepEqual(v2Traces.coverage.usage_coverage_breakdown, {
    observed: 1,
    observed_zero: 1,
    unavailable: 1,
  });
  assert.deepEqual(v2Traces.coverage.cost_coverage_breakdown, {
    priced: 2,
    partial: 0,
    unpriced: 0,
    unavailable: 1,
  });

  const legacyBrowser = await getJson<{
    id: string;
    fidelity: string;
    trace_coverage: Record<string, unknown> | null;
  }>(`/api/v2/sessions/${legacyId}`);
  assert.equal(legacyBrowser.fidelity, 'summary');
  assert.equal(legacyBrowser.trace_coverage?.usage_coverage, 'unavailable');
  assert.equal(legacyBrowser.trace_coverage?.tool_outcome_coverage, 'unrecorded');

  const warehouseRows = listWarehouseSessionTraceSummaries()
    .map(row => mapSummaryToRunRow(row, 'local', 'run-slice5-1'));
  for (const row of warehouseRows) assertContentFree(row);

  const zeroRow = warehouseRows.find(r => r.session_id === zeroId)!;
  assert.equal(zeroRow.usage_coverage, 'observed_zero');
  assert.equal(zeroRow.input_tokens, 0);
  assert.equal(zeroRow.output_tokens, 0);
  assert.equal(zeroRow.cost_usd, 0);
  assert.equal(zeroRow.cost_coverage, 'priced');
  assert.equal(zeroRow.cost_provenance, 'estimated');

  const legacyRow = warehouseRows.find(r => r.session_id === legacyId)!;
  assert.equal(legacyRow.usage_coverage, 'unavailable');
  assert.equal(legacyRow.input_tokens, null);
  assert.equal(legacyRow.output_tokens, null);
  assert.equal(legacyRow.cache_read_tokens, null);
  assert.equal(legacyRow.cache_write_tokens, null);
  assert.equal(legacyRow.cost_usd, null);
  assert.equal(legacyRow.cost_coverage, 'unavailable');
  assert.equal(legacyRow.has_full_transcript, false);

  const usageOnlyRow = warehouseRows.find(r => r.session_id === usageOnlyId)!;
  assert.equal(usageOnlyRow.usage_coverage, 'observed');
  assert.equal(usageOnlyRow.has_full_transcript, false);
  assert.equal(usageOnlyRow.input_tokens, 1000);
});

test('unknown model preserves token buckets, remains unpriced, and surfaces partial/unpriced coverage', () => {
  const unknownOnlyId = 'agr-unknown-model-001';
  const mixedPriceId = 'agr-mixed-price-001';
  const t0 = Math.floor(Date.parse('2026-11-26T12:00:00Z') / 1000);

  writeConversationDb(agrHome, unknownOnlyId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 }],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-future-unpriced-99',
        input: 4200,
        output: 800,
        cacheRead: 12000,
        cacheWrite: 300,
        thinking: 250,
        modelEnum: 1020,
        createdAtSecs: t0 + 2,
        messageId: 'unk-1',
      }),
    }],
  });

  writeConversationDb(agrHome, mixedPriceId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 + 100 }],
    gens: [
      {
        idx: 0,
        blob: buildGenBlob({
          model: 'gemini-4-carbon',
          input: 1_000_000,
          output: 0,
          createdAtSecs: Math.floor(Date.parse('2026-11-26T12:00:00Z') / 1000),
          messageId: 'mix-known-promo',
        }),
      },
      {
        idx: 1,
        blob: buildGenBlob({
          model: 'gemini-4-carbon',
          input: 1_000_000,
          output: 0,
          createdAtSecs: Math.floor(Date.parse('2026-12-02T12:00:00Z') / 1000),
          messageId: 'mix-known-list',
        }),
      },
      {
        idx: 2,
        blob: buildGenBlob({
          model: 'gemini-future-unpriced-99',
          input: 500,
          output: 100,
          createdAtSecs: Math.floor(Date.parse('2026-12-02T12:01:00Z') / 1000),
          messageId: 'mix-unknown',
        }),
      },
    ],
  });

  const db = getDb();
  runImport({ source: 'antigravity', antigravityDir: agrHome, force: true });

  const unknownRow = db.prepare(`
    SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, cost_source
    FROM events WHERE session_id = ? AND event_type = 'llm_response'
  `).get(unknownOnlyId) as {
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number | null;
    cost_source: string | null;
  };
  assert.equal(unknownRow.tokens_in, 4200);
  assert.equal(unknownRow.tokens_out, 800);
  assert.equal(unknownRow.cache_read_tokens, 12000);
  assert.equal(unknownRow.cache_write_tokens, 300);
  assert.equal(unknownRow.cost_usd, null);
  assert.equal(unknownRow.cost_source, null);

  const unknownSummary = deriveSessionTraceSummary(unknownOnlyId, db);
  assert.equal(unknownSummary.tokens_in, 4200);
  assert.equal(unknownSummary.tokens_out, 800);
  assert.equal(unknownSummary.cache_read_tokens, 12000);
  assert.equal(unknownSummary.cache_write_tokens, 300);
  assert.equal(unknownSummary.coverage.usage_coverage, 'observed');
  assert.equal(unknownSummary.coverage.cost_coverage, 'unpriced');
  assert.equal(unknownSummary.coverage.cost_provenance, 'unavailable');
  assert.equal(unknownSummary.coverage.has_cost, false);

  const mixedSummary = deriveSessionTraceSummary(mixedPriceId, db);
  assert.equal(mixedSummary.cost_usd, 6);
  assert.equal(mixedSummary.coverage.usage_coverage, 'observed');
  assert.equal(mixedSummary.coverage.cost_coverage, 'partial');
  assert.equal(mixedSummary.coverage.cost_provenance, 'estimated');
  assert.equal(mixedSummary.coverage.has_cost, true);

  const rows = listWarehouseSessionTraceSummaries().map(row => mapSummaryToRunRow(row, 'local', 'run-slice5-2'));
  for (const row of rows) assertContentFree(row);

  const exportedUnknown = rows.find(r => r.session_id === unknownOnlyId)!;
  assert.equal(exportedUnknown.input_tokens, 4200);
  assert.equal(exportedUnknown.output_tokens, 800);
  assert.equal(exportedUnknown.cache_read_tokens, 12000);
  assert.equal(exportedUnknown.cache_write_tokens, 300);
  assert.equal(exportedUnknown.cost_usd, null);
  assert.equal(exportedUnknown.cost_coverage, 'unpriced');

  const exportedMixed = rows.find(r => r.session_id === mixedPriceId)!;
  assert.equal(exportedMixed.cost_usd, 6);
  assert.equal(exportedMixed.cost_coverage, 'partial');
  assert.equal(exportedMixed.cost_provenance, 'estimated');
});

test('approximate/unattributed timestamps and unrecorded tool outcomes surface in v2 and warehouse export', async () => {
  const approxId = 'agr-approx-unrecorded-001';
  const t0 = Math.floor(Date.parse('2026-11-26T14:00:00Z') / 1000);

  writeConversationDb(agrHome, approxId, {
    steps: [
      { idx: 0, stepType: 14, oneof: 19, secs: t0 },
      { idx: 1, stepType: 28, oneof: 28, status: 2, secs: t0 + 5 },
    ],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-4-neon',
        input: 1000,
        output: 200,
      }),
    }],
    transcriptLines: [
      {
        step_index: 0,
        created_at: '2026-11-26T14:00:00.000Z',
        source: 'USER',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'Run the build',
      },
      {
        step_index: 1,
        created_at: '2026-11-26T14:00:02.000Z',
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'run_command', args: { command: 'pnpm build' } }],
      },
      {
        step_index: 2,
        created_at: '2026-11-26T14:00:05.000Z',
        source: 'TOOL',
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'building...',
      },
    ],
  });

  const db = getDb();
  syncAllAntigravityFiles(db, agrHome, { force: true });

  const detail = await getJson<{
    trace: { coverage: Record<string, unknown> };
    coverage: {
      timestamp_coverage_breakdown: { exact: number; approximate: number; unavailable: number };
      tool_outcome_coverage_breakdown: { complete: number; partial: number; unrecorded: number; not_applicable: number };
    };
  }>(`/api/v2/trace-quality/traces/${sessionTraceId(approxId)}`);

  assert.equal(detail.trace.coverage.timestamp_coverage, 'approximate');
  assert.equal(detail.trace.coverage.tool_outcome_coverage, 'unrecorded');
  assert.equal(detail.coverage.timestamp_coverage_breakdown.approximate, 1);
  assert.equal(detail.coverage.tool_outcome_coverage_breakdown.unrecorded, 1);

  const exported = mapSummaryToRunRow(
    listWarehouseSessionTraceSummaries().find(r => r.session_id === approxId)!,
    'local',
    'run-slice5-3',
  );
  assertContentFree(exported);
  assert.equal(exported.timestamp_coverage, 'approximate');
  assert.equal(exported.tool_outcome_coverage, 'unrecorded');
});

test('mixed-source warehouse export (Claude + Codex + Antigravity) preserves coverage and content-free privacy contract', () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO browsing_sessions (id, agent, project, first_message, started_at, ended_at, message_count, user_message_count, integration_mode, fidelity)
    VALUES
      ('claude-s1', 'claude', 'proj-a', 'Secret prompt text that must never export', '2026-11-26T08:00:00Z', '2026-11-26T08:05:00Z', 2, 1, 'claude-jsonl', 'full'),
      ('codex-s1', 'codex', 'proj-b', 'Another secret prompt', '2026-11-26T09:00:00Z', '2026-11-26T09:05:00Z', 2, 1, 'codex-jsonl', 'full')
  `).run();

  db.prepare(`
    INSERT INTO session_items (session_id, ordinal, source_item_id, kind, status, payload_json, created_at)
    VALUES
      ('claude-s1', 0, 'tc-1', 'tool_call', 'success', '{"tool_name":"Read","input":{"file_path":"/Users/example/secret.txt"}}', '2026-11-26T08:01:00Z'),
      ('claude-s1', 1, 'tc-1', 'tool_result', 'success', '{"content":"TOP SECRET FILE BODY","is_error":false}', '2026-11-26T08:01:05Z'),
      ('codex-s1', 0, 'cx-1', 'tool_call', 'success', '{"tool_name":"shell","input":{"command":"ls"}}', '2026-11-26T09:01:00Z'),
      ('codex-s1', 1, 'cx-1', 'tool_result', 'completed', '{"content":"output","outcome":"unrecorded"}', '2026-11-26T09:01:05Z')
  `).run();

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, model, project,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
      cost_usd, cost_source, source, client_timestamp, metadata
    ) VALUES
      ('cl-e1', 'claude-s1', 'claude_code', 'llm_response', 'success', 'claude-sonnet-5', 'proj-a', 2000, 400, 100, 0, 0.015, 'reported', 'import', '2026-11-26T08:01:00Z', '{}'),
      ('cx-e1', 'codex-s1', 'codex', 'llm_response', 'success', 'gpt-5.4', 'proj-b', 3000, 600, 500, 0, 0.02, 'estimated', 'import', '2026-11-26T09:01:00Z', '{}')
  `).run();

  const agrId = 'agr-mixed-export-001';
  const t0 = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);
  writeConversationDb(agrHome, agrId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 }],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-4-neon',
        input: 4000,
        output: 800,
        cacheRead: 2000,
        createdAtSecs: t0 + 1,
        messageId: 'agr-mix-1',
      }),
    }],
    transcriptLines: [
      {
        step_index: 0,
        created_at: '2026-11-26T10:00:00.000Z',
        source: 'USER',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'Confidential Antigravity prompt',
      },
      {
        step_index: 1,
        created_at: '2026-11-26T10:00:01.000Z',
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Confidential Antigravity answer',
      },
    ],
  });
  syncAllAntigravityFiles(db, agrHome, { force: true });
  maintainSessionTraceSummary('claude-s1', db);
  maintainSessionTraceSummary('codex-s1', db);

  const rows = listWarehouseSessionTraceSummaries().map(row => mapSummaryToRunRow(row, 'local', 'run-mixed'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assertContentFree(row);
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes('Secret'), false);
    assert.equal(serialized.includes('Confidential'), false);
    assert.equal(serialized.includes('TOP SECRET'), false);
  }

  const claude = rows.find(r => r.session_id === 'claude-s1')!;
  const codex = rows.find(r => r.session_id === 'codex-s1')!;
  const agr = rows.find(r => r.session_id === agrId)!;

  assert.equal(claude.usage_coverage, 'observed');
  assert.equal(claude.cost_provenance, 'reported');
  assert.equal(claude.tool_outcome_coverage, 'complete');
  assert.equal(claude.has_full_transcript, true);

  assert.equal(codex.usage_coverage, 'observed');
  assert.equal(codex.cost_provenance, 'estimated');
  assert.equal(codex.tool_outcome_coverage, 'unrecorded');
  assert.equal(codex.has_full_transcript, true);

  assert.equal(agr.usage_coverage, 'observed');
  assert.equal(agr.cost_provenance, 'estimated');
  assert.equal(agr.timestamp_coverage, 'exact');
  assert.equal(agr.has_full_transcript, true);

  assert.throws(
    () => assertContentFree({ ...claude, usage_coverage: 'free-text-leak' } as unknown as WarehouseRunRow),
    /usage_coverage/,
  );
  assert.throws(
    () => assertContentFree({ ...claude, usage_coverage: 'unavailable', input_tokens: 0 } as WarehouseRunRow),
    /unavailable/,
  );

  const plan = planRuns(rows, {
    run_id: 'run-mixed',
    created_at: '2026-11-26T11:00:00.000Z',
    account: 'local',
    window_start: null,
    window_end: null,
    sessions_published: rows.length,
    sessions_suppressed: 0,
    min_batch: 0,
    amon_version: '0.5.0',
    grant_role: null,
    grant_skipped: false,
  }, {
    enabled: false,
    dsn: null,
    account: 'local',
    schema: 'agentmonitor',
    biRole: null,
  });
  assert.ok(plan.statements.some(sql => sql.includes('usage_coverage') && sql.includes('tool_outcome_coverage')));
});

test('derived session_trace_summary rebuilds cleanly after Antigravity usage repair and cost recalculation', () => {
  const repairId = 'agr-repair-summary-001';
  const t0 = Math.floor(Date.parse('2026-11-26T15:00:00Z') / 1000);
  writeConversationDb(agrHome, repairId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 }],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-4-neon',
        input: 1_000_000,
        output: 0,
        modelEnum: 1020,
        createdAtSecs: t0 + 1,
        messageId: 'rep-msg-1',
      }),
    }],
  });

  const db = getDb();
  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, model,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
      cost_usd, cost_source, source, client_timestamp, metadata
    ) VALUES ('import-agr-legacy-stale', ?, 'antigravity', 'llm_response', 'success', 'gemini-4-neon', 1001020, 0, 0, 0, NULL, NULL, 'import', NULL, ?)
  `).run(repairId, JSON.stringify({ _source: 'antigravity_db', timestamp_source: 'unavailable' }));
  maintainSessionTraceSummary(repairId, db);

  const beforeSummary = db.prepare('SELECT tokens_in, cost_usd, coverage_json FROM session_trace_summary WHERE session_id = ?')
    .get(repairId) as { tokens_in: number; cost_usd: number; coverage_json: string };
  assert.equal(beforeSummary.tokens_in, 1001020);
  assert.equal((JSON.parse(beforeSummary.coverage_json) as { cost_coverage?: string }).cost_coverage, 'unpriced');
  assert.equal((JSON.parse(beforeSummary.coverage_json) as { timestamp_coverage?: string }).timestamp_coverage, 'unavailable');

  const repairReport = repairAntigravityImportUsage(db, { antigravityDir: agrHome, apply: true });
  assert.equal(repairReport.sessions_changed, 1);
  assert.equal(repairReport.sessions_resummarized, 1);

  const afterRepair = db.prepare('SELECT tokens_in, cost_usd, coverage_json FROM session_trace_summary WHERE session_id = ?')
    .get(repairId) as { tokens_in: number; cost_usd: number; coverage_json: string };
  assert.equal(afterRepair.tokens_in, 1_000_000);
  assert.equal(afterRepair.cost_usd, 3);
  const repairedCov = JSON.parse(afterRepair.coverage_json) as Record<string, unknown>;
  assert.equal(repairedCov.cost_coverage, 'priced');
  assert.equal(repairedCov.cost_provenance, 'estimated');
  assert.equal(repairedCov.timestamp_coverage, 'exact');

  db.prepare("UPDATE events SET cost_usd = NULL, cost_source = NULL WHERE session_id = ? AND event_type = 'llm_response'")
    .run(repairId);
  maintainSessionTraceSummary(repairId, db);
  assert.equal(
    (JSON.parse(
      (db.prepare('SELECT coverage_json FROM session_trace_summary WHERE session_id = ?').get(repairId) as { coverage_json: string }).coverage_json,
    ) as { cost_coverage?: string }).cost_coverage,
    'unpriced',
  );

  const recalcReport = recalculateEventCosts(db, { apply: true, missingOnly: true });
  assert.equal(recalcReport.updated, 1);
  assert.equal(recalcReport.sessions_resummarized, 1);
  const afterRecalc = db.prepare('SELECT cost_usd, coverage_json FROM session_trace_summary WHERE session_id = ?')
    .get(repairId) as { cost_usd: number; coverage_json: string };
  assert.equal(afterRecalc.cost_usd, 3);
  assert.equal((JSON.parse(afterRecalc.coverage_json) as { cost_coverage?: string }).cost_coverage, 'priced');
});

test('amon sync sessions supports --source antigravity and includes Antigravity in --source all', async () => {
  const agrId = 'agr-cli-sync-001';
  const t0 = Math.floor(Date.parse('2026-11-26T16:00:00Z') / 1000);
  writeConversationDb(agrHome, agrId, {
    steps: [{ idx: 0, stepType: 14, oneof: 19, secs: t0 }],
    gens: [{
      idx: 0,
      blob: buildGenBlob({
        model: 'gemini-4-neon',
        input: 250,
        output: 50,
        createdAtSecs: t0 + 1,
        messageId: 'cli-sync-msg-1',
      }),
    }],
  });

  const dryRun = await runCli([
    'sync', 'sessions', '--source', 'antigravity', '--antigravity-dir', agrHome, '--dry-run', '--json',
  ]);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout) as {
    dry_run: boolean;
    source: string;
    claude_files: number;
    codex_files: number;
    antigravity_files: number;
    total_files: number;
  };
  assert.equal(dryPayload.dry_run, true);
  assert.equal(dryPayload.source, 'antigravity');
  assert.equal(dryPayload.claude_files, 0);
  assert.equal(dryPayload.codex_files, 0);
  assert.equal(dryPayload.antigravity_files, 1);
  assert.equal(dryPayload.total_files, 1);

  const firstSync = await runCli([
    'sync', 'sessions', '--source', 'antigravity', '--antigravity-dir', agrHome, '--json',
  ]);
  assert.equal(firstSync.exitCode, 0, firstSync.stderr);
  const firstPayload = JSON.parse(firstSync.stdout) as {
    dry_run: boolean;
    source: string;
    antigravity: { parsed: number; skipped: number; errors: number; total: number };
    parsed: number;
    total_files: number;
  };
  assert.equal(firstPayload.dry_run, false);
  assert.equal(firstPayload.source, 'antigravity');
  assert.equal(firstPayload.antigravity.parsed, 1);
  assert.equal(firstPayload.parsed, 1);
  assert.equal(firstPayload.total_files, 1);

  const secondSync = await runCli([
    'sync', 'sessions', '--source', 'antigravity', '--antigravity-dir', agrHome, '--json',
  ]);
  assert.equal(secondSync.exitCode, 0, secondSync.stderr);
  const secondPayload = JSON.parse(secondSync.stdout) as {
    antigravity: { parsed: number; skipped: number; total: number };
  };
  assert.equal(secondPayload.antigravity.parsed, 0);
  assert.equal(secondPayload.antigravity.skipped, 1);

  const forceAll = await runCli([
    'sync', 'sessions', '--source', 'all', '--force',
    '--claude-dir', claudeDir, '--codex-home', codexHome, '--antigravity-dir', agrHome, '--json',
  ]);
  assert.equal(forceAll.exitCode, 0, forceAll.stderr);
  const forcePayload = JSON.parse(forceAll.stdout) as {
    source: string;
    antigravity: { parsed: number; total: number };
    parsed: number;
    total_files: number;
  };
  assert.equal(forcePayload.source, 'all');
  assert.equal(forcePayload.antigravity.parsed, 1);
  assert.equal(forcePayload.antigravity.total, 1);
  assert.equal(forcePayload.parsed, 1);
  assert.equal(forcePayload.total_files, 1);
});
