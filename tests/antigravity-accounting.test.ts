import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type { insertEvent as insertEventFn } from '../src/db/queries.js';
import type { getDailyConversationActivity as getDailyFn } from '../src/db/v2-queries.js';
import type { parseAntigravityFile as parseAgrFileFn, stepKindToEvent as stepKindToEventFn } from '../src/import/antigravity.js';
import type { decodeStepEnvelope as decodeStepEnvFn } from '../src/import/antigravity/proto.js';
import type { parseAntigravitySessions as parseAgrSessionsFn } from '../src/parser/antigravity-sessions.js';

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

function stepBlob(type: number, oneof: number, payload: number[] = [...vField(1, 1)]): Buffer {
  return buf([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, payload)]);
}

function plannerStepBlob(opts: { messageId?: string; providerId?: string } = {}): Buffer {
  const payload: number[] = [...sField(1, 'ok')];
  if (opts.messageId !== undefined) payload.push(...sField(6, opts.messageId));
  if (opts.providerId !== undefined) payload.push(...sField(15, opts.providerId));
  return stepBlob(15, 20, payload);
}

function stepMetaBlob(secs: number, nanos?: number): Buffer {
  const ts = [...vField(1, secs)];
  if (nanos !== undefined) ts.push(...vField(2, nanos));
  return buf(lField(1, ts));
}

function genMetaBlob(opts: {
  model?: string;
  modelFull?: string;
  modelDisplay?: string;
  usage?: {
    modelEnum?: number;
    input?: number;
    output?: number;
    cacheWrite?: number;
    cacheRead?: number;
    messageId?: string;
    thinking?: number;
    answer?: number;
    providerId?: string;
  };
  createdAt?: { secs: number; nanos?: number };
}): Buffer {
  const gm: number[] = [];
  if (opts.model !== undefined) gm.push(...sField(19, opts.model));
  if (opts.modelDisplay !== undefined) gm.push(...sField(21, opts.modelDisplay));
  if (opts.modelFull !== undefined) gm.push(...sField(22, opts.modelFull));
  if (opts.usage) {
    const u: number[] = [];
    if (opts.usage.modelEnum !== undefined) u.push(...vField(1, opts.usage.modelEnum));
    if (opts.usage.input !== undefined) u.push(...vField(2, opts.usage.input));
    if (opts.usage.output !== undefined) u.push(...vField(3, opts.usage.output));
    if (opts.usage.cacheWrite !== undefined) u.push(...vField(4, opts.usage.cacheWrite));
    if (opts.usage.cacheRead !== undefined) u.push(...vField(5, opts.usage.cacheRead));
    if (opts.usage.messageId !== undefined) u.push(...sField(7, opts.usage.messageId));
    if (opts.usage.thinking !== undefined) u.push(...vField(9, opts.usage.thinking));
    if (opts.usage.answer !== undefined) u.push(...vField(10, opts.usage.answer));
    if (opts.usage.providerId !== undefined) u.push(...sField(12, opts.usage.providerId));
    gm.push(...lField(4, u));
  }
  if (opts.createdAt) {
    const ts = [...vField(1, opts.createdAt.secs)];
    if (opts.createdAt.nanos !== undefined) ts.push(...vField(2, opts.createdAt.nanos));
    gm.push(...lField(9, lField(4, ts)));
  }
  return buf(lField(1, gm));
}

let tempRoot = '';
let closeDb: typeof closeDbFn;
let getDb: typeof getDbFn;
let insertEvent: typeof insertEventFn;
let getDailyConversationActivity: typeof getDailyFn;
let parseAntigravityFile: typeof parseAgrFileFn;
let stepKindToEvent: typeof stepKindToEventFn;
let decodeStepEnvelope: typeof decodeStepEnvFn;
let parseAntigravitySessions: typeof parseAgrSessionsFn;

function makeDb(
  uuid: string,
  steps: Array<{ idx: number; type: number; payload: Buffer; meta: Buffer | null }>,
  gens: Buffer[],
): string {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  const dbPath = path.join(dir, `${uuid}.db`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
  const insStep = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const s of steps) insStep.run(s.idx, s.type, 3, s.payload, s.meta);
  const insGen = db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  gens.forEach((g, idx) => insGen.run(idx, g));
  db.close();
  return dbPath;
}

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-acct-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempRoot, 'monitor.db');
  process.env.AGENTMONITOR_TIMEZONE = 'UTC';

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));

  ({ insertEvent } = await import('../src/db/queries.js'));
  ({ getDailyConversationActivity } = await import('../src/db/v2-queries.js'));
  ({ parseAntigravityFile, stepKindToEvent } = await import('../src/import/antigravity.js'));
  ({ decodeStepEnvelope } = await import('../src/import/antigravity/proto.js'));
  ({ parseAntigravitySessions } = await import('../src/parser/antigravity-sessions.js'));
});

after(() => {
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('nonzero modelEnum (field 1) never enters tokens_in, context_used_tokens, or USD cost', () => {
  const ts = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
  const dbPath = makeDb(
    'agr-enum-0001',
    [
      { idx: 0, type: 14, payload: stepBlob(14, 19), meta: stepMetaBlob(ts) },
      { idx: 1, type: 15, payload: plannerStepBlob({ messageId: 'bot-enum-1' }), meta: stepMetaBlob(ts + 5) },
    ],
    [
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: {
          modelEnum: 1531,
          input: 100_000,
          output: 10_000,
          cacheRead: 200_000,
          thinking: 4_000,
          answer: 6_000,
          messageId: 'bot-enum-1',
        },
      }),
    ],
  );

  const llm = parseAntigravityFile(dbPath).find(e => e.event_type === 'llm_response');
  assert.ok(llm);
  assert.equal(llm.tokens_in, 100_000);
  assert.equal(llm.tokens_out, 10_000);
  assert.equal(llm.cache_read_tokens, 200_000);
  assert.equal(llm.cache_write_tokens, 0);
  assert.equal((llm.metadata as { thoughts_tokens: number }).thoughts_tokens, 4_000);
  const expectedUsd = 0.1 * 3 + 0.01 * 15 + 0.2 * 0.15;
  assert.ok(llm.cost_usd !== undefined && Math.abs(llm.cost_usd - expectedUsd) < 1e-9, `got ${llm.cost_usd}`);

  const parsed = parseAntigravitySessions(dbPath);
  assert.equal(parsed.metadata.context_used_tokens, 300_000);
});

test('covers cold request, cache hit, cache_write_tokens pricing, missing fields, and unknown model', () => {
  const ts = Date.UTC(2026, 10, 20, 14, 0, 0) / 1000;
  const dbPath = makeDb(
    'agr-buckets-0002',
    [
      { idx: 0, type: 14, payload: stepBlob(14, 19), meta: stepMetaBlob(ts) },
      { idx: 1, type: 15, payload: plannerStepBlob({ messageId: 'cold-1' }), meta: stepMetaBlob(ts + 1) },
      { idx: 2, type: 15, payload: plannerStepBlob({ messageId: 'cw-2' }), meta: stepMetaBlob(ts + 2) },
      { idx: 3, type: 15, payload: plannerStepBlob({ messageId: 'unk-3' }), meta: stepMetaBlob(ts + 3) },
      { idx: 4, type: 15, payload: plannerStepBlob({ messageId: 'min-4' }), meta: stepMetaBlob(ts + 4) },
    ],
    [
      genMetaBlob({
        model: 'gemini-4-hydrogen-tiered-xhigh',
        usage: { modelEnum: 1532, input: 10_000, output: 1_000, thinking: 700, answer: 300, messageId: 'cold-1' },
      }),
      genMetaBlob({
        model: 'claude-opus-5-5',
        usage: {
          modelEnum: 1020,
          input: 10_000,
          output: 2_000,
          cacheWrite: 100_000,
          cacheRead: 50_000,
          thinking: 1_200,
          answer: 800,
          messageId: 'cw-2',
        },
      }),
      genMetaBlob({
        model: 'gemini-99-unpriced',
        usage: { modelEnum: 1016, input: 5_000, output: 500, cacheWrite: 2_000, cacheRead: 1_000, messageId: 'unk-3' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, messageId: 'min-4' },
      }),
    ],
  );

  const llms = parseAntigravityFile(dbPath).filter(e => e.event_type === 'llm_response');
  assert.equal(llms.length, 4);

  assert.equal(llms[0].tokens_in, 10_000);
  assert.equal(llms[0].tokens_out, 1_000);
  assert.equal(llms[0].cache_read_tokens, 0);
  assert.equal(llms[0].cache_write_tokens, 0);

  assert.equal(llms[1].tokens_in, 10_000);
  assert.equal(llms[1].tokens_out, 2_000);
  assert.equal(llms[1].cache_write_tokens, 100_000);
  assert.equal(llms[1].cache_read_tokens, 50_000);
  const expectedOpusCost = 0.01 * 4 + 0.002 * 20 + 0.05 * 0.2 + 0.1 * 5;
  assert.ok(llms[1].cost_usd !== undefined && Math.abs(llms[1].cost_usd - expectedOpusCost) < 1e-9, `got ${llms[1].cost_usd}`);

  assert.equal(llms[2].tokens_in, 5_000);
  assert.equal(llms[2].tokens_out, 500);
  assert.equal(llms[2].cache_write_tokens, 2_000);
  assert.equal(llms[2].cache_read_tokens, 1_000);
  assert.equal(llms[2].cost_usd, undefined);
  assert.equal(llms[2].cost_source, undefined);

  assert.equal(llms[3].tokens_in, 0);
  assert.equal(llms[3].tokens_out, 0);
  assert.equal(llms[3].cache_write_tokens, 0);
  assert.equal(llms[3].cache_read_tokens, 0);

  const parsed = parseAntigravitySessions(dbPath);
  assert.equal(parsed.metadata.context_used_tokens, 8_000);
});

test('resolves generation timestamps in priority order with explicit provenance and refuses duplicate IDs', () => {
  const t0 = Date.UTC(2026, 10, 20, 10, 0, 0) / 1000;
  const t1 = Date.UTC(2026, 10, 20, 10, 1, 0) / 1000;
  const t2 = Date.UTC(2026, 10, 20, 10, 2, 0) / 1000;
  const t3 = Date.UTC(2026, 10, 20, 10, 3, 0) / 1000;
  const t4 = Date.UTC(2026, 10, 20, 10, 4, 0) / 1000;
  const t5 = Date.UTC(2026, 10, 20, 10, 5, 0) / 1000;

  const dbPath = makeDb(
    'agr-ts-0003',
    [
      { idx: 0, type: 14, payload: stepBlob(14, 19), meta: stepMetaBlob(t0) },
      { idx: 1, type: 15, payload: plannerStepBlob({ messageId: 'm-legacy', providerId: 'p-legacy' }), meta: stepMetaBlob(t1) },
      { idx: 2, type: 15, payload: plannerStepBlob({ messageId: 'm-unique', providerId: 'p-unique' }), meta: stepMetaBlob(t2, 250_000_000) },
      { idx: 3, type: 15, payload: plannerStepBlob({ messageId: 'm-other', providerId: 'p-only' }), meta: stepMetaBlob(t3, 500_000_000) },
      { idx: 4, type: 15, payload: plannerStepBlob({ messageId: 'm-dup', providerId: 'p-dup' }), meta: stepMetaBlob(t4) },
      { idx: 5, type: 15, payload: plannerStepBlob({ messageId: 'm-dup', providerId: 'p-dup' }), meta: stepMetaBlob(t5) },
      { idx: 6, type: 15, payload: plannerStepBlob({ messageId: 'm-ambig-fallback', providerId: 'p-fallback-ok' }), meta: stepMetaBlob(t5, 125_000_000) },
      { idx: 7, type: 15, payload: plannerStepBlob({ messageId: 'm-ambig-fallback' }), meta: stepMetaBlob(t4) },
      { idx: 8, type: 15, payload: plannerStepBlob({ messageId: 'm-dup-same' }), meta: stepMetaBlob(t4) },
      { idx: 9, type: 15, payload: plannerStepBlob({ messageId: 'm-dup-same' }), meta: stepMetaBlob(t4) },
      { idx: 10, type: 15, payload: plannerStepBlob({ messageId: 'm-no-meta' }), meta: null },
    ],
    [
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-legacy', providerId: 'p-legacy' },
        createdAt: { secs: t0 + 10, nanos: 750_000_000 },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-unique', providerId: 'p-unique' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, providerId: 'p-only' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-dup', providerId: 'p-dup' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-ambig-fallback', providerId: 'p-fallback-ok' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-missing' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-dup-same' },
      }),
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-no-meta' },
      }),
    ],
  );

  const llms = parseAntigravityFile(dbPath).filter(e => e.event_type === 'llm_response');
  assert.equal(llms.length, 8);

  assert.equal(llms[0].client_timestamp, new Date((t0 + 10) * 1000 + 750).toISOString());
  assert.equal((llms[0].metadata as { timestamp_source: string }).timestamp_source, 'generation_created_at');

  assert.equal(llms[1].client_timestamp, new Date(t2 * 1000 + 250).toISOString());
  assert.equal((llms[1].metadata as { timestamp_source: string }).timestamp_source, 'planner_message_id');

  assert.equal(llms[2].client_timestamp, new Date(t3 * 1000 + 500).toISOString());
  assert.equal((llms[2].metadata as { timestamp_source: string }).timestamp_source, 'planner_provider_message_id');

  assert.equal(llms[3].client_timestamp, undefined);
  assert.equal((llms[3].metadata as { timestamp_source: string }).timestamp_source, 'unavailable');

  assert.equal(llms[4].client_timestamp, new Date(t5 * 1000 + 125).toISOString());
  assert.equal((llms[4].metadata as { timestamp_source: string }).timestamp_source, 'planner_provider_message_id');

  assert.equal(llms[5].client_timestamp, undefined);
  assert.equal((llms[5].metadata as { timestamp_source: string }).timestamp_source, 'unavailable');

  assert.equal(llms[6].client_timestamp, undefined);
  assert.equal((llms[6].metadata as { timestamp_source: string }).timestamp_source, 'unavailable');

  assert.equal(llms[7].client_timestamp, undefined);
  assert.equal((llms[7].metadata as { timestamp_source: string }).timestamp_source, 'unavailable');
});

test('pricing boundary: gemini-4-carbon session crossing 2026-12-01 prices joined generation at list rates, not firstTs promo rates', () => {
  const preCutover = Date.UTC(2026, 10, 30, 23, 55, 0) / 1000;
  const postCutover = Date.UTC(2026, 11, 1, 0, 5, 0) / 1000;

  const dbPath = makeDb(
    'agr-boundary-0004',
    [
      { idx: 0, type: 14, payload: stepBlob(14, 19), meta: stepMetaBlob(preCutover) },
      { idx: 1, type: 15, payload: plannerStepBlob({ messageId: 'carbon-1' }), meta: stepMetaBlob(preCutover + 10) },
      { idx: 2, type: 15, payload: plannerStepBlob({ messageId: 'carbon-2' }), meta: stepMetaBlob(postCutover) },
    ],
    [
      genMetaBlob({
        model: 'gemini-4-carbon-high',
        usage: { modelEnum: 1531, input: 1_000_000, output: 100_000, cacheRead: 1_000_000, messageId: 'carbon-1' },
      }),
      genMetaBlob({
        model: 'gemini-4-carbon-high',
        usage: { modelEnum: 1531, input: 1_000_000, output: 100_000, cacheRead: 1_000_000, messageId: 'carbon-2' },
      }),
    ],
  );

  const llms = parseAntigravityFile(dbPath).filter(e => e.event_type === 'llm_response');
  assert.equal(llms.length, 2);
  const promoExpected = 1 * 2 + 0.1 * 10 + 1 * 0.1;
  const listExpected = 1 * 4 + 0.1 * 20 + 1 * 0.2;
  assert.ok(llms[0].cost_usd !== undefined && Math.abs(llms[0].cost_usd - promoExpected) < 1e-9, `pre got ${llms[0].cost_usd}`);
  assert.ok(llms[1].cost_usd !== undefined && Math.abs(llms[1].cost_usd - listExpected) < 1e-9, `post got ${llms[1].cost_usd}`);
});

test('unattributed imported generations insert cleanly with null client_timestamp and stay out of dated activity windows', () => {
  const stepSec = Date.UTC(2026, 10, 20, 9, 0, 0) / 1000;
  const dbPath = makeDb(
    'agr-unattributed-0005',
    [
      { idx: 0, type: 14, payload: stepBlob(14, 19), meta: stepMetaBlob(stepSec) },
    ],
    [
      genMetaBlob({
        model: 'gemini-4-neon',
        usage: { modelEnum: 1531, input: 20_000, output: 1_000 },
      }),
    ],
  );

  const llm = parseAntigravityFile(dbPath).find(e => e.event_type === 'llm_response');
  assert.ok(llm);
  assert.equal(llm.client_timestamp, undefined);
  assert.equal((llm.metadata as { timestamp_source: string }).timestamp_source, 'unavailable');

  const inserted = insertEvent(llm);
  assert.ok(inserted);
  assert.equal(inserted.client_timestamp, null);
  assert.equal(JSON.parse(inserted.metadata).timestamp_source, 'unavailable');

  const today = new Date().toISOString().slice(0, 10);
  const activity = getDailyConversationActivity(today, today);
  assert.equal(activity.data.length, 0);
  assert.ok(activity.unresolved_timestamps >= 1);
});

test('decodes newly recovered CLI step oneofs directory_rules (156) and tool_search (157)', () => {
  const dirEnv = decodeStepEnvelope(stepBlob(156, 156));
  assert.equal(dirEnv.kind, 'directory_rules');
  assert.deepEqual(stepKindToEvent(dirEnv.kind), { type: 'response' });

  const toolEnv = decodeStepEnvelope(stepBlob(157, 157));
  assert.equal(toolEnv.kind, 'tool_search');
  assert.deepEqual(stepKindToEvent(toolEnv.kind), { type: 'tool_use', toolName: 'tool_search' });

  const ts = Date.UTC(2026, 10, 20, 15, 0, 0) / 1000;
  const fallbackDb = makeDb(
    'agr-model-fallback-0006',
    [
      { idx: 0, type: 15, payload: plannerStepBlob({ messageId: 'm-full' }), meta: stepMetaBlob(ts) },
      { idx: 1, type: 15, payload: plannerStepBlob({ messageId: 'm-disp' }), meta: stepMetaBlob(ts + 1) },
    ],
    [
      genMetaBlob({ modelFull: 'gemini-4-neon-xhigh', usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-full' } }),
      genMetaBlob({ modelDisplay: 'Gemini 4 Neon (High)', usage: { modelEnum: 1531, input: 100, output: 10, messageId: 'm-disp' } }),
    ],
  );
  const llms = parseAntigravityFile(fallbackDb).filter(e => e.event_type === 'llm_response');
  assert.deepEqual(llms.map(e => e.model), ['gemini-4-neon-xhigh', 'Gemini 4 Neon (High)']);
});
