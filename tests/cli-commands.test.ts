import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before } from 'node:test';
import { main } from '../src/cli.js';

class CaptureStream extends Writable {
  output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

let tempDir = '';
let claudeDir = '';
let codexHome = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
  process.env.AGENTMONITOR_USAGE_BUDGETS_PATH = path.join(tempDir, 'budgets.json');
  claudeDir = path.join(tempDir, 'claude');
  codexHome = path.join(tempDir, 'codex');
  fs.mkdirSync(path.join(claudeDir, 'projects', 'project-a'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });

  const { initSchema } = await import('../src/db/schema.js');
  const { closeDb, getDb } = await import('../src/db/connection.js');
  initSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, file_path, file_size, file_hash
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cli-session-001',
    'agentmonitor',
    'codex',
    'Investigate CLI behavior',
    '2026-06-15T10:00:00.000Z',
    null,
    7,
    7,
    '/tmp/session.jsonl',
    100,
    'hash',
  );
  db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('cli-session-001', 0, 'user', 'Investigate CLI behavior', '2026-06-15T10:00:00.000Z', 0, 0, 24);
  const insertSearchMessage = db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, content_length)
    VALUES ('cli-session-001', ?, 'user', ?, '2026-06-15T10:00:00.000Z', ?)
  `);
  for (const [index, content] of [
    'cursorprobe cursorprobe cursorprobe cursorprobe',
    'cursorprobe cursorprobe cursorprobe cursorprobe',
    'cursorprobe cursorprobe cursorprobe cursorprobe',
    'cursorprobe cursorprobe sizing test',
    'cursorprobe sparse transcript match',
    'cursorprobe sparse transcript match',
  ].entries()) {
    insertSearchMessage.run(index + 1, content, content.length);
  }
  db.prepare(`
    INSERT INTO events (
      session_id, agent_type, event_type, status, tokens_in, tokens_out, project,
      created_at, model, cost_usd, source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cli-session-001',
    'codex',
    'llm_response',
    'success',
    100,
    50,
    'agentmonitor',
    '2026-06-15T10:00:00.000Z',
    'gpt-5.4',
    0.001,
    'import',
  );
  closeDb();
});

after(async () => {
  const { closeDb } = await import('../src/db/connection.js');
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sessions list emits JSON from the configured database', async () => {
  const result = await runCli(['sessions', 'list', '--json', '--limit', '5']);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { data: Array<{ id: string }> };
  assert.equal(parsed.data[0]?.id, 'cli-session-001');
});

type SearchPage = { data: Array<{ message_ordinal: number }>; total: number; cursor?: string };

for (const [sort, expectedPages] of [
  ['recent', [[6, 5], [4, 3], [2, 1], []]],
  ['relevance', [[3, 2], [1, 4], [6, 5], []]],
] as const) {
  test(`sessions search walks ${sort} pages in order until the cursor is exhausted`, async () => {
    const args = ['sessions', 'search', 'cursorprobe', '--sort', sort, '--limit', '2', '--json'];
    let cursor: string | undefined;
    for (const [index, expectedOrdinals] of expectedPages.entries()) {
      const result = await runCli(cursor ? [...args, '--cursor', cursor] : args);
      assert.equal(result.exitCode, 0, result.stderr);
      const page = JSON.parse(result.stdout) as SearchPage;
      assert.deepEqual(page.data.map(row => row.message_ordinal), expectedOrdinals);
      assert.equal(page.total, 6);
      cursor = page.cursor;
      if (index < expectedPages.length - 1) assert.ok(cursor);
    }
    assert.equal(cursor, undefined);
  });
}

for (const [sort, otherSort, malformed] of [
  ['recent', 'relevance', '1junk'],
  ['relevance', 'recent', '???'],
] as const) {
  test(`sessions search rejects malformed or wrong-sort cursors for ${sort}`, async () => {
    const args = ['sessions', 'search', 'cursorprobe', '--limit', '2', '--json'];
    const first = await runCli([...args, '--sort', otherSort]);
    assert.equal(first.exitCode, 0, first.stderr);
    const { cursor } = JSON.parse(first.stdout) as SearchPage;
    assert.ok(cursor);

    for (const invalidCursor of [malformed, cursor]) {
      const result = await runCli([...args, '--sort', sort, '--cursor', invalidCursor]);
      assert.equal(result.exitCode, 2, result.stderr || result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /cursor/i);
    }
  });
}

test('paginated session commands document --cursor in help', async () => {
  for (const command of [['sessions', 'search'], ['sessions', 'list'], ['live', 'sessions']]) {
    const result = await runCli([...command, '--help']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /--cursor\b/, command.join(' '));
  }
});

test('live items reads the newest page with --tail and pages back with --before', async () => {
  const { getDb, closeDb } = await import('../src/db/connection.js');
  const db = getDb();
  for (let n = 1; n <= 5; n++) {
    const turnId = Number(db.prepare(`
      INSERT INTO session_turns (session_id, agent_type, source_turn_id, status, title)
      VALUES ('cli-session-001', 'codex', ?, 'completed', 't')
    `).run(`codex-message:${n}`).lastInsertRowid);
    db.prepare(`
      INSERT INTO session_items (session_id, turn_id, ordinal, source_item_id, kind, status, payload_json)
      VALUES ('cli-session-001', ?, 0, ?, 'assistant_message', 'success', ?)
    `).run(turnId, `cli-item-${n}`, JSON.stringify({ text: `item ${n}` }));
  }
  const ids = (db.prepare("SELECT id FROM session_items WHERE session_id = 'cli-session-001' ORDER BY id").all() as Array<{ id: number }>).map(row => row.id);
  closeDb();

  type Page = { data: Array<{ id: number }>; before_cursor?: string };
  const tail = await runCli(['live', 'items', 'cli-session-001', '--tail', '--limit', '2', '--json']);
  assert.equal(tail.exitCode, 0);
  const tailPage = JSON.parse(tail.stdout) as Page;
  assert.deepEqual(tailPage.data.map(item => item.id), ids.slice(-2));

  const earlier = await runCli(['live', 'items', 'cli-session-001', '--before', String(tailPage.before_cursor), '--limit', '2', '--json']);
  assert.deepEqual((JSON.parse(earlier.stdout) as Page).data.map(item => item.id), ids.slice(-4, -2));

  const invalid = await runCli(['live', 'items', 'cli-session-001', '--before', 'abc']);
  assert.notEqual(invalid.exitCode, 0);
});

test('monitor tools keeps elapsed intervals, source timers and power coverage separate', async t => {
  for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
    const previous = process.env[key];
    process.env[key] = codexHome;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const id = '11111111-1111-4111-8111-111111111111';
  const basename = `rollout-2026-06-15T12-00-00-${id}`;
  const file = path.join(codexHome, 'sessions', `${basename}.jsonl`);
  const lines = [
    ['00', 'session_meta', { id }],
    ['01', 'response_item', { type: 'custom_tool_call', call_id: 'one', name: 'exec', input: 'private input' }],
    ['02', 'response_item', { type: 'function_call', call_id: 'two', name: 'lookup', arguments: '{}' }],
    ['04', 'response_item', { type: 'function_call_output', call_id: 'two', output: 'private result' }],
    ['06', 'response_item', { type: 'custom_tool_call_output', call_id: 'one', output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:' },
      { type: 'input_text', text: 'private result' },
    ] }],
  ];
  fs.writeFileSync(file, lines.map(([sec, type, payload]) =>
    JSON.stringify({ timestamp: `2026-06-15T12:00:${sec}.000Z`, type, payload })).join('\n') + '\n');
  const { getDb, closeDb } = await import('../src/db/connection.js');
  getDb().prepare(`INSERT INTO browsing_sessions (id, agent, project, integration_mode, file_path)
    VALUES (?, 'codex', 'example', 'codex-jsonl', ?)`).run(basename, file);
  closeDb();

  const args = ['monitor', 'tools', '--session-id', id];
  const first = await runCli([...args, '--limit', '1', '--json']);
  assert.equal(first.exitCode, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.session_id, id);
  assert.equal(report.coverage.status, 'available');
  assert.equal(report.elapsed_union_ms, 5000);
  assert.equal(report.reported_calls, 1);
  assert.equal(report.total_calls, 2);
  assert.equal(report.next_offset, 1);
  assert.equal(report.calls[0].elapsed_ms, 5000);
  assert.equal(report.calls[0].reported_ms, 300);
  assert.equal(report.calls[0].reported_source, 'codex_code_mode_wall_time');
  assert.equal(report.sleep.sleep_overlap_ms, null);
  assert.doesNotMatch(first.stdout, /private input|private result/);

  const second = await runCli(['monitor', 'tools', '--session-id', basename, '--offset', '1', '--json']);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).calls[0].reported_ms, null);
  assert.equal(JSON.parse(second.stdout).elapsed_union_ms, 5000);
  const plain = await runCli(args);
  assert.match(plain.stdout, /REPORTED/);
  assert.match(plain.stdout, /unknown/i);

  const replacement = path.join(path.dirname(file), 'rollout-2026-06-16T12-00-00-22222222-2222-4222-8222-222222222222.jsonl');
  fs.renameSync(file, replacement);
  const { default: Database } = await import('better-sqlite3');
  const state = new Database(path.join(codexHome, 'state_5.sqlite'));
  try {
    state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    state.prepare('INSERT INTO threads VALUES (?, ?)').run(id, replacement);
  } finally { state.close(); }
  const fromNative = await runCli([...args, '--json']);
  assert.equal(fromNative.exitCode, 0, fromNative.stderr);
  assert.equal(JSON.parse(fromNative.stdout).source_selection, 'native_index');
  assert.equal(JSON.parse(fromNative.stdout).total_calls, 2);

  fs.unlinkSync(path.join(codexHome, 'state_5.sqlite'));
  const replacementName = `rollout-2026-06-16T12-00-00-${id}_22222222-2222-4222-8222-222222222222`;
  getDb().prepare('UPDATE browsing_sessions SET id = ?, file_path = ? WHERE id = ?').run(replacementName, replacement, basename);
  closeDb();
  for (const alias of [id, replacementName]) {
    const indexed = await runCli(['monitor', 'tools', '--session-id', alias, '--json']);
    assert.equal(indexed.exitCode, 0, indexed.stderr);
    assert.equal(JSON.parse(indexed.stdout).session_id, id);
    assert.equal(JSON.parse(indexed.stdout).total_calls, 2);
  }
  fs.unlinkSync(replacement);
  const missingSource = await runCli([...args, '--json']);
  assert.equal(missingSource.exitCode, 0, missingSource.stderr);
  assert.equal(JSON.parse(missingSource.stdout).coverage.status, 'unavailable');
  assert.equal(JSON.parse(missingSource.stdout).elapsed_union_ms, null);
  const missingSession = await runCli(['monitor', 'tools', '--session-id', 'never-indexed']);
  assert.equal(missingSession.exitCode, 4);
  for (const invalid of [[...args, '--agent', 'codex'], [...args, '--limit', '0'],
    [...args, '--power-host', 'other-host.invalid'], ['monitor', 'tools', '--offset', '1']]) {
    assert.equal((await runCli(invalid)).exitCode, 2);
  }
  getDb().prepare('DELETE FROM browsing_sessions WHERE id = ?').run(replacementName);
  closeDb();
});

test('sessions show returns exit 4 for missing sessions', async () => {
  const result = await runCli(['sessions', 'show', 'missing-session']);

  assert.equal(result.exitCode, 4);
  assert.match(result.stderr, /Session not found/);
});

test('sessions repair-projects --names previews a listed rename without writing', async () => {
  const names = path.join(tempDir, 'names.json');
  fs.writeFileSync(names, JSON.stringify({ agentmonitor: 'agentmonitor-renamed', 'never-stored': null }));
  const result = await runCli(['sessions', 'repair-projects', '--names', names, '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { apply: boolean; rows: Record<string, number>; renames: unknown[] };
  assert.equal(report.apply, false);
  assert.deepEqual(report.rows, { events: 1, sessions: 0, browsing_sessions: 1 });
  assert.deepEqual(report.renames, [{ from: 'agentmonitor', to: 'agentmonitor-renamed', sessions: 1 }]);
  const listed = await runCli(['sessions', 'list', '--json']);
  assert.match(listed.stdout, /"project": ?"agentmonitor"/);
});

test('sessions repair-projects --names rejects a list it cannot read as names', async () => {
  for (const [file, body] of [['not-json.json', '{'], ['number.json', '{"tmp": 3}'], ['empty.json', '{"tmp": " "}'], ['array.json', '["tmp"]'], ['same.json', '{"tmp": "tmp"}'],
    // WHY: When a target is also a source, a sequential rename would make the result depend on key
    // order.
    ['chain.json', '{"old": "new", "new": null}'], ['swap.json', '{"a": "b", "b": "a"}']]) {
    const names = path.join(tempDir, file);
    fs.writeFileSync(names, body);
    const result = await runCli(['sessions', 'repair-projects', '--names', names]);
    assert.equal(result.exitCode, 2, `${file}: ${result.stderr}`);
    assert.match(result.stderr, /--names/);
  }
});

test('usage summary emits cost totals as JSON', async () => {
  const result = await runCli(['usage', 'summary', '--json']);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { total_cost_usd: number; total_usage_events: number };
  assert.equal(parsed.total_cost_usd, 0.001);
  assert.equal(parsed.total_usage_events, 1);
});

test('sync sessions dry-run previews discovered files without writing', async () => {
  fs.writeFileSync(path.join(claudeDir, 'projects', 'project-a', 'empty.jsonl'), '');
  const result = await runCli([
    'sync',
    'sessions',
    '--dry-run',
    '--claude-dir',
    claudeDir,
    '--codex-home',
    codexHome,
    '--json',
  ]);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; total_files: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.total_files, 1);
});

test('sync sessions defaults to the configured Claude history root', async () => {
  const previous = process.env.AGENTMONITOR_CLAUDE_DIR;
  process.env.AGENTMONITOR_CLAUDE_DIR = claudeDir;
  try {
    const result = await runCli([
      'sync',
      'sessions',
      '--source',
      'claude',
      '--dry-run',
      '--json',
    ]);

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { claude_files: number; total_files: number };
    assert.equal(parsed.claude_files, 1);
    assert.equal(parsed.total_files, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENTMONITOR_CLAUDE_DIR;
    else process.env.AGENTMONITOR_CLAUDE_DIR = previous;
  }
});

test('hooks print-codex-config uses the requested URL', async () => {
  const result = await runCli(['--url', 'http://127.0.0.1:3999', 'hooks', 'print-codex-config']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /endpoint = "http:\/\/127\.0\.0\.1:3999\/api\/otel\/v1\/logs"/);
  assert.match(result.stdout, /endpoint = "http:\/\/127\.0\.0\.1:3999\/api\/otel\/v1\/metrics"/);
});

test('live watch preserves SSE data lines split across chunks', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: live_update\n'));
        controller.enqueue(encoder.encode('data: {"type":"live'));
        controller.enqueue(encoder.encode('_update","id":1}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    const result = await runCli(['--url', 'http://127.0.0.1:3999', 'live', 'watch', 'cli-session-001', '--since-now']);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '{"type":"live_update","id":1}\n');
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/api/v2/live/stream');
    assert.equal(url.searchParams.get('session_id'), 'cli-session-001');
    assert.equal(url.searchParams.has('since'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live watch filters SSE payloads by live item kind', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"connected","payload":{"replayed":0}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"item_delta","payload":{"kind":"reasoning"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"item_delta","payload":{"item":{"kind":"tool_call"}}}\n\n'));
        controller.enqueue(encoder.encode('data: not-json\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"item_delta","payload":{"kind":"tool_result"}}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    const result = await runCli(['--url', 'http://127.0.0.1:3999', 'live', 'watch', '--kinds', 'tool_call,tool_result']);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      '{"type":"item_delta","payload":{"item":{"kind":"tool_call"}}}\n'
      + 'not-json\n'
      + '{"type":"item_delta","payload":{"kind":"tool_result"}}\n',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('monitor watch preserves the legacy Monitor SSE schema as NDJSON and forwards filters', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: event\n'));
        controller.enqueue(encoder.encode('data: {"type":"event","pay'));
        controller.enqueue(encoder.encode('load":{"id":7}}\n\n'));
        controller.enqueue(encoder.encode('event: stats\ndata: {"type":"stats","payload":{"total_events":1}}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    const result = await runCli([
      '--url', 'http://127.0.0.1:3999',
      'monitor', 'watch', '--agent', 'codex', '--event-type', 'tool_use',
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      '{"type":"event","payload":{"id":7}}\n'
      + '{"type":"stats","payload":{"total_events":1}}\n',
    );
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/api/stream');
    assert.equal(url.searchParams.get('agent_type'), 'codex');
    assert.equal(url.searchParams.get('event_type'), 'tool_use');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('watch commands map connection failures to unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  try {
    for (const command of [['live', 'watch'], ['monitor', 'watch']]) {
      const result = await runCli(['--url', 'http://127.0.0.1:3999', ...command]);
      assert.equal(result.exitCode, 3, `${command.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Cannot reach http:\/\/127\.0\.0\.1:3999/);
      assert.doesNotMatch(result.stderr, /unexpected error/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('watch commands map interrupted response streams to unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    const result = await runCli(['--url', 'http://127.0.0.1:3999', 'monitor', 'watch']);
    assert.equal(result.exitCode, 3, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Stream from http:\/\/127\.0\.0\.1:3999\/api\/stream failed/);
    assert.doesNotMatch(result.stderr, /unexpected error/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
