import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

// The importer, repair, and usage reader all use a real, isolated store.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-codex-pages-'));
const dbPath = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_DB_PATH = dbPath;
process.env.AGENTMONITOR_TIMEZONE = 'UTC';

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { runImport, reconcileCodexRollout } = await import('../src/import/index.js');
const { discoverCodexLogs } = await import('../src/import/codex.js');
const { repairCodexImportUsage } = await import('../src/import/codex-usage-repair.js');
const { insertEvent } = await import('../src/db/queries.js');
const { getUsageSummary } = await import('../src/db/v2-queries.js');

const SESSION = '01a20000-0000-7000-8000-000000000001';
const PAGE = '01a20000-0000-7000-8000-000000000002';
const MODEL = 'gpt-5.6-terra';
const OLD_DAY = '2026-11-01';
const SUFFIX_DAY = '2026-11-02';
const TODAY = '2026-11-11';
const codexDir = path.join(tempDir, 'codex');
type Line = Record<string, unknown>;

function meta(ordinal: number, day: string, extra: Line = {}): Line {
  return {
    ordinal, type: 'session_meta', timestamp: `${day}T10:00:00Z`,
    payload: {
      id: SESSION, cwd: '/synthetic/paginated-project', source: 'cli',
      timestamp: `${OLD_DAY}T10:00:00Z`, history_mode: 'paginated', ...extra,
    },
  };
}
const turn = (ordinal: number, day: string): Line => ({
  ordinal, type: 'turn_context', timestamp: `${day}T10:00:01Z`, payload: { model: MODEL },
});
const counter = (ordinal: number, day: string, minute: number, input: number, cached: number, output: number): Line => ({
  ordinal, type: 'event_msg', timestamp: `${day}T10:${String(minute).padStart(2, '0')}:00Z`,
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  },
});
const jsonl = (lines: Line[]): string => lines.map(line => JSON.stringify(line)).join('\n') + '\n';

// The active page references the first request. The root's later request was
// discarded from the conversation by a revert, but its bill remains real.
const prefix = [meta(0, OLD_DAY), turn(1, OLD_DAY), counter(2, OLD_DAY, 1, 200_000, 100_000, 2_000)];
const rootLines = [...prefix, turn(3, SUFFIX_DAY), counter(4, SUFFIX_DAY, 1, 205_000, 102_000, 2_050)];
const pageLines = [
  meta(3, TODAY, {
    history_base: {
      thread_id: SESSION,
      end_byte_offset: Buffer.byteLength(jsonl(prefix), 'utf8'),
      end_ordinal_exclusive: 3,
    },
  }),
  turn(4, TODAY),
  counter(5, TODAY, 1, 200_000, 100_000, 2_000), // Repeated inherited total, no new request.
  counter(6, TODAY, 2, 201_000, 100_400, 2_010),
];

function fixture(pageFirst = false, createPageFirst = false): { root: string; page: string } {
  const root = path.join(codexDir, 'sessions', pageFirst ? 'z-root' : 'a-root', `rollout-2026-11-01T10-00-00-${SESSION}.jsonl`);
  const page = path.join(codexDir, 'sessions', pageFirst ? 'a-page' : 'z-page', `rollout-2026-11-11T10-00-00-${PAGE}.jsonl`);
  for (const file of [root, page]) fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [file, lines] of createPageFirst ? [[page, pageLines], [root, rootLines]] as const : [[root, rootLines], [page, pageLines]] as const) {
    fs.writeFileSync(file, jsonl(lines));
  }
  return { root, page };
}

type UsageRow = {
  id: number; event_id: string; client_timestamp: string; tokens_in: number;
  cache_read_tokens: number; tokens_out: number; cost_usd: number;
};
function usageRows(): UsageRow[] {
  return getDb().prepare(`
    SELECT id, event_id, client_timestamp, tokens_in, cache_read_tokens, tokens_out, cost_usd
    FROM events WHERE session_id = ? AND source = 'import' AND event_type = 'llm_response'
    ORDER BY client_timestamp, event_id
  `).all(SESSION) as UsageRow[];
}
function allRows() {
  return getDb().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY event_id').all(SESSION);
}
function importAll(force = false) {
  return runImport({ source: 'codex', codexDir, force });
}

// Fixed oracle: this model charges $2/M uncached, $0.2/M cached, $12/M
// output below its long-context threshold. Each physical request is below it.
function assertUsage(appended = false): void {
  const today = getUsageSummary({ agent: 'codex', date_from: TODAY, date_to: TODAY });
  assert.equal(today.total_input_tokens, appended ? 1_800 : 600, 'today excludes the historical cumulative carry');
  assert.equal(today.total_cache_read_tokens, appended ? 1_200 : 400);
  assert.equal(today.total_output_tokens, appended ? 30 : 10);
  assert.equal(today.total_cost_usd, appended ? 0.0042 : 0.0014);
  assert.equal(today.total_usage_events, appended ? 2 : 1, 'the repeated opening counter is not a billed request');

  const older = getUsageSummary({ agent: 'codex', date_from: OLD_DAY, date_to: SUFFIX_DAY });
  assert.equal(older.total_cost_usd, 0.251, 'a revert does not erase already billed requests in the old root suffix');
  assert.equal(older.total_input_tokens, 103_000);
  assert.equal(older.total_cache_read_tokens, 102_000);
  assert.equal(older.total_output_tokens, 2_050);
  assert.equal(older.total_usage_events, 2);

  const rows = usageRows();
  assert.equal(rows.length, appended ? 4 : 3);
  assert.equal(new Set(rows.map(row => row.event_id)).size, rows.length, 'root suffix and page delta have separate physical identities');
  assert.deepEqual(rows.map(({ tokens_in, cache_read_tokens, tokens_out }) => [tokens_in, cache_read_tokens, tokens_out]),
    [[100_000, 100_000, 2_000], [3_000, 2_000, 50], [600, 400, 10], ...(appended ? [[1_200, 800, 20]] : [])]);
  assert.ok(rows.filter(row => row.client_timestamp.startsWith(TODAY)).every(row => row.tokens_in + row.cache_read_tokens < 3_000),
    'no giant inherited-total event is emitted today');
}

function reset(): void {
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(dbPath));
  getDb().exec(`
    DELETE FROM events; DELETE FROM sessions; DELETE FROM import_state; DELETE FROM session_trace_summary;
    DELETE FROM session_items; DELETE FROM session_turns; DELETE FROM browsing_sessions;
  `);
  fs.rmSync(codexDir, { recursive: true, force: true });
}
before(() => { initSchema(); });
beforeEach(reset);
after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

for (const pageFirst of [false, true]) {
  for (const createPageFirst of [false, true]) {
    test(`paginated billing preserves old requests with ${pageFirst ? 'page' : 'root'} discovered first and ${createPageFirst ? 'page' : 'root'} created first`, () => {
      const files = fixture(pageFirst, createPageFirst);
      const discovered = discoverCodexLogs(codexDir);
      assert.equal(discovered[0], pageFirst ? files.page : files.root, 'the fixture exercises both discovery orders');
      importAll();
      assertUsage();
      const before = allRows();
      const unchanged = importAll();
      assert.equal(unchanged.totalEventsImported + unchanged.totalEventsRefreshed + unchanged.totalEventsRemoved, 0);
      assert.deepEqual(allRows(), before);
      const forced = importAll(true);
      assert.equal(forced.totalEventsImported + forced.totalEventsRefreshed + forced.totalEventsRemoved, 0);
      assert.deepEqual(allRows(), before, 'forced reconcile has the same complete history');
      assertUsage();
    });
  }
}

test('a newly discovered page and later append preserve the already imported root and page requests', () => {
  const files = fixture();
  fs.rmSync(files.page);
  importAll();
  const rootBefore = usageRows();
  assert.equal(rootBefore.length, 2, 'both old physical requests were imported before the page existed');
  fs.writeFileSync(files.page, jsonl(pageLines));
  importAll();
  assertUsage();
  assert.deepEqual(usageRows().slice(0, 2), rootBefore);
  const beforeAppend = usageRows();
  fs.appendFileSync(files.page, jsonl([counter(7, TODAY, 3, 203_000, 101_200, 2_030)]));
  importAll();
  assertUsage(true);
  assert.deepEqual(usageRows().slice(0, 3), beforeAppend, 'an append retains the earlier physical row identities and timestamps');
  const beforeForce = allRows();
  importAll(true);
  assert.deepEqual(allRows(), beforeForce);
});

test('usage repair reconciles the complete physical lineage once and removes a historical carry billed today', () => {
  fixture(true);
  // Seed a genuine old store through runImport, then add the erroneous carry
  // that the old page-local counter parser would have billed on the new date.
  importAll();
  insertEvent({
    event_id: 'import-cdx-legacy-paginated-carry', session_id: SESSION,
    agent_type: 'codex', event_type: 'llm_response', status: 'success', source: 'import',
    model: MODEL, tokens_in: 100_000, cache_read_tokens: 100_000, tokens_out: 2_000,
    cost_usd: 0.244, cost_source: 'estimated', client_timestamp: `${TODAY}T10:01:00Z`, metadata: {},
  });
  assert.ok(getUsageSummary({ date_from: TODAY, date_to: TODAY }).total_cost_usd > 0.24, 'positive control: the seeded carry is visible in the consumer summary');
  const before = allRows();
  const preview = repairCodexImportUsage(getDb(), { codexDir, apply: false });
  assert.ok(preview.rows_deleted > 0);
  assert.deepEqual(allRows(), before, 'repair preview has no writes');
  const applied = repairCodexImportUsage(getDb(), { codexDir, apply: true });
  assert.deepEqual(applied.sessions_failed, []);
  assert.deepEqual(applied.counter_mismatches, [], 'physical segment totals account for genuinely billed reverted suffixes');
  assertUsage();
  const repaired = allRows();
  const again = repairCodexImportUsage(getDb(), { codexDir, apply: true });
  assert.equal(again.rows_inserted + again.rows_updated + again.rows_deleted, 0);
  assert.deepEqual(allRows(), repaired);
  importAll(true);
  assert.deepEqual(allRows(), repaired, 'normal import agrees with repair');
});

test('a missing referenced prefix cannot replace previously complete billed history', () => {
  // This ordering lets the old importer leave the root's historical rows in
  // place, so the red assertion below reaches the missing-prefix mutation.
  const files = fixture(true);
  importAll();
  const before = allRows();
  assert.equal(usageRows().filter(row => row.client_timestamp.startsWith(OLD_DAY)).length, 1,
    'positive control: the known prefix contributes a stored historical request');
  const rootContent = fs.readFileSync(files.root);
  fs.rmSync(files.root);
  fs.appendFileSync(files.page, jsonl([counter(7, TODAY, 3, 203_000, 101_200, 2_030)]));
  const incomplete = importAll();
  assert.ok(incomplete.files.some(file => 'error' in file && typeof file.error === 'string' && /missing|unresolved/i.test(file.error)),
    'normal import exposes the unresolved prefix instead of reporting a successful reconcile');
  assert.deepEqual(allRows(), before, 'an unresolved page leaves the complete old projection untouched');
  importAll(true);
  assert.deepEqual(allRows(), before);
  const repaired = repairCodexImportUsage(getDb(), { codexDir, apply: true });
  assert.equal(repaired.sessions_failed.length, 1, 'repair reports the unresolved logical session once');
  assert.match(repaired.sessions_failed[0].error, /missing|unresolved/i);
  assert.equal(repaired.rows_inserted + repaired.rows_updated + repaired.rows_deleted, 0);
  assert.deepEqual(allRows(), before, 'repair also refuses to erase history without its prefix');
  fs.writeFileSync(files.root, rootContent);
  importAll();
  assertUsage(true);
});

test('a continuation bills its native request record immediately before any new cumulative counter', () => {
  const files = fixture();
  const request = (ordinal: number, day: string, responseId: string, input: number, total: number): Line => ({
    ordinal, type: 'token_usage_record', timestamp: `${day}T10:01:00Z`,
    payload: {
      response_id: responseId, thread_id: SESSION,
      usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
      thread_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0 },
    },
  });
  const historical = [
    meta(0, OLD_DAY), turn(1, OLD_DAY), request(2, OLD_DAY, 'synthetic-root-request', 100, 100),
    counter(3, OLD_DAY, 2, 100, 0, 0),
  ];
  fs.writeFileSync(files.root, jsonl(historical));
  fs.rmSync(files.page);
  importAll();
  const oldRows = usageRows();
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].tokens_in, 100);

  fs.writeFileSync(files.page, jsonl([
    meta(4, TODAY, {
      history_base: { thread_id: SESSION, end_byte_offset: Buffer.byteLength(jsonl(historical)), end_ordinal_exclusive: 4 },
    }),
    turn(5, TODAY), request(6, TODAY, 'synthetic-page-request', 20, 120),
  ]));
  importAll();
  const today = getUsageSummary({ agent: 'codex', date_from: TODAY, date_to: TODAY });
  assert.equal(today.total_input_tokens, 20, 'the native record is billable without waiting for another token_count');
  assert.equal(today.total_cost_usd, 0.00004);
  assert.equal(today.total_usage_events, 1);
  assert.deepEqual(usageRows().slice(0, 1), oldRows, 'the old native request is retained once');
  assert.deepEqual(usageRows().map(row => row.tokens_in), [100, 20]);
  const before = allRows();
  importAll(true);
  assert.deepEqual(allRows(), before);
});

test('public rollout reconcile finds an external leaf\'s neighboring history without codexDir', () => {
  const files = fixture(true);
  const previousHome = process.env.CODEX_HOME;
  // A known-empty alternate home makes any accidental ambient lookup safe and
  // proves the source of the resolved prefix is the external rollout tree.
  process.env.CODEX_HOME = path.join(tempDir, 'unrelated-codex-home');
  try {
    const result = reconcileCodexRollout(files.page, { apply: true });
    assert.equal(result.counts.reconciled, true);
    assertUsage();
    const before = allRows();
    reconcileCodexRollout(files.page, { apply: true });
    assert.deepEqual(allRows(), before);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});

test('relative Codex roots import and repair the same complete family as absolute roots', () => {
  fixture(true);
  importAll();
  assertUsage();
  const absoluteUsage = usageRows().map(row => ({ ...row, id: 0 }));
  reset();
  fixture(true);
  const relativeDir = path.relative(process.cwd(), codexDir);
  const relativeImport = (force = false) => runImport({ source: 'codex', codexDir: relativeDir, force });
  const first = relativeImport();
  assert.ok(first.files.every(file => !('error' in file)), 'the relative source resolves every member and prefix');
  assertUsage();
  assert.deepEqual(usageRows().map(row => ({ ...row, id: 0 })), absoluteUsage);
  const beforeReruns = allRows();
  for (const force of [false, true, false]) {
    const result = relativeImport(force);
    assert.equal(result.totalEventsImported + result.totalEventsRefreshed + result.totalEventsRemoved, 0);
    assert.deepEqual(allRows(), beforeReruns, 'relative normal and forced reruns preserve the family');
  }

  insertEvent({
    event_id: 'import-cdx-relative-legacy-carry', session_id: SESSION,
    agent_type: 'codex', event_type: 'llm_response', status: 'success', source: 'import',
    model: MODEL, tokens_in: 100_000, cache_read_tokens: 100_000, tokens_out: 2_000,
    cost_usd: 0.244, cost_source: 'estimated', client_timestamp: `${TODAY}T10:01:00Z`, metadata: {},
  });
  const absolutePreview = repairCodexImportUsage(getDb(), { codexDir, apply: false });
  const relativePreview = repairCodexImportUsage(getDb(), { codexDir: relativeDir, apply: false });
  assert.ok(absolutePreview.rows_deleted > 0, 'the repair parity check includes a real correction');
  assert.deepEqual(relativePreview, absolutePreview);
  const repaired = repairCodexImportUsage(getDb(), { codexDir: relativeDir, apply: true });
  assert.deepEqual(repaired.sessions_failed, []);
  assert.deepEqual(repaired.counter_mismatches, []);
  assertUsage();
  assert.deepEqual(usageRows().map(row => ({ ...row, id: 0 })), absoluteUsage);
  const afterRepair = allRows();
  relativeImport(true);
  assert.deepEqual(allRows(), afterRepair);
});

test('forced date-scoped reruns retain each physical member\'s stored usage instrument', () => {
  const files = fixture();
  const request = (ordinal: number, day: string, responseId: string, input: number, total: number): Line => ({
    ordinal, type: 'token_usage_record', timestamp: `${day}T10:01:00Z`,
    payload: {
      response_id: responseId, thread_id: SESSION,
      usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
      thread_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0 },
    },
  });
  // The root's records started mid-thread, so it must retain counter billing.
  const historical = [
    meta(0, OLD_DAY), turn(1, OLD_DAY), request(2, OLD_DAY, 'synthetic-mid-thread-request', 60, 100),
    counter(3, OLD_DAY, 2, 100, 0, 0),
  ];
  fs.writeFileSync(files.root, jsonl(historical));
  fs.writeFileSync(files.page, jsonl([
    meta(4, TODAY, {
      history_base: { thread_id: SESSION, end_byte_offset: Buffer.byteLength(jsonl(historical)), end_ordinal_exclusive: 4 },
    }),
    turn(5, TODAY), request(6, TODAY, 'synthetic-complete-page-request', 50, 150),
    counter(7, TODAY, 2, 150, 0, 0),
  ]));
  importAll();
  assert.deepEqual(usageRows().map(row => row.tokens_in), [100, 50]);
  const instruments = getDb().prepare(`
    SELECT json_extract(metadata, '$._usage_source') AS usage_source
    FROM events WHERE session_id = ? AND event_type = 'llm_response' ORDER BY client_timestamp
  `).all(SESSION);
  assert.deepEqual(instruments, [{ usage_source: null }, { usage_source: 'request' }],
    'positive control: the family really mixes counter and complete native request billing');
  const before = allRows();
  for (let repeat = 0; repeat < 3; repeat++) {
    const result = runImport({ source: 'codex', codexDir, force: true, from: new Date('2026-01-01T00:00:00Z') });
    assert.equal(result.totalEventsImported, 0, 'a scoped rerun must not append a leaf counter beside its native request');
    assert.deepEqual(allRows(), before);
    const summary = getUsageSummary({ agent: 'codex' });
    assert.equal(summary.total_input_tokens, 150);
    assert.equal(summary.total_usage_events, 2);
  }
});


for (const compressed of [false, true]) {
  test(`a complete subagent imports its own usage when copied parent metadata has a history bookmark (${compressed ? 'compressed' : 'plain'})`, () => {
    const parent = '01000000-0000-7000-8000-000000000099';
    const file = path.join(codexDir, 'sessions', `rollout-2026-11-11T10-00-00-${SESSION}.jsonl${compressed ? '.zst' : ''}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ownTurn = { ...turn(4, TODAY), payload: { model: MODEL, turn_id: SESSION } };
    const inheritedTurn = { ...turn(2, OLD_DAY), payload: { model: MODEL, turn_id: parent } };
    const lines = [
      meta(0, TODAY, {
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
        subagent_history_start_ordinal: 4,
      }),
      { ordinal: 1, type: 'session_meta', timestamp: `${OLD_DAY}T10:00:00Z`, payload: {
        id: parent, history_mode: 'paginated',
        // This bookmark is the copied parent's context, not a missing dependency
        // of the complete child rollout. No matching source file is needed.
        history_base: { thread_id: '01000000-0000-7000-8000-000000000098', end_ordinal_exclusive: 5, end_byte_offset: 100 },
      } },
      inheritedTurn, counter(3, OLD_DAY, 1, 100, 0, 0),
      ownTurn, counter(5, TODAY, 2, 130, 0, 0),
    ];
    const bytes = Buffer.from(jsonl(lines));
    fs.writeFileSync(file, compressed ? zstdCompressSync(bytes) : bytes);
    if (compressed) {
      const repaired = repairCodexImportUsage(getDb(), { codexDir, apply: true });
      assert.deepEqual(repaired.sessions_failed, [], 'repair must ignore the copied parent bookmark');
      assert.equal(repaired.sessions_changed, 1);
    }
    const imported = importAll();
    assert.deepEqual(imported.files.flatMap(result => result.error ? [result.error] : []), [],
      'only the authoritative child header can declare an unresolved history dependency');
    assert.equal(getUsageSummary({ agent: 'codex' }).total_input_tokens, 30);
    assert.equal(getUsageSummary({ agent: 'codex', date_from: OLD_DAY, date_to: OLD_DAY }).total_input_tokens, 0);
    const before = allRows();
    const preview = repairCodexImportUsage(getDb(), { codexDir, apply: false });
    assert.deepEqual(preview.sessions_failed, []);
    assert.equal(preview.sessions_changed, 0);
    assert.deepEqual(allRows(), before);
    importAll(true);
    assert.deepEqual(allRows(), before);
  });
}
