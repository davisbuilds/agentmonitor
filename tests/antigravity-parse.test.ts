import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseAntigravityFile, stepKindToEvent, discoverAntigravityLogs } from '../src/import/antigravity.js';

// --- minimal protobuf encoder (deterministic fixtures) ---
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

// Full gemini_coder.Step: type(1), status(4), metadata(5), <oneof>(payload)
const step = (type: number, oneof: number) =>
  buf([...vField(1, type), ...vField(4, 3), ...lField(5, [...vField(1, 1)]), ...lField(oneof, [...vField(1, 1)])]);
// CortexStepMetadata column: field1.field1 = unix seconds
const meta = (secs: number) => buf(lField(1, [...vField(1, secs)]));
// gen_metadata: wrapper(1) → CortexGeneratorMetadata { model(19), usage(4) }
const genmeta = (model: string, u: Record<number, number>) =>
  buf(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, u[1]), ...vField(2, u[2]), ...vField(3, u[3]), ...vField(5, u[5]), ...vField(9, u[9]), ...vField(10, u[10])]),
  ]));

function buildFixture(uuid: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-'));
  const dbPath = path.join(dir, `${uuid}.db`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB);');
  const ins = db.prepare('INSERT INTO steps(idx,step_type,status,step_payload,metadata) VALUES (?,?,?,?,?)');
  ins.run(0, 14, 3, step(14, 19), meta(1782000000)); // type 14, oneof 19 = user_input
  ins.run(1, 28, 3, step(28, 28), meta(1782000005)); // run_command
  ins.run(2, 999, 3, step(999, 9998), meta(1782000010)); // unknown oneof → generic
  db.prepare('INSERT INTO gen_metadata(idx,data) VALUES (?,?)').run(
    0,
    genmeta('gemini-pro-default', { 1: 1016, 2: 20000, 3: 3000, 5: 8000, 9: 2500, 10: 500 }),
  );
  db.close();
  return dbPath;
}

test('parseAntigravityFile: one session keyed to the conversation UUID with a session_start', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const events = parseAntigravityFile(buildFixture(uuid));
  assert.ok(events.every((e) => e.session_id === uuid), 'all events keyed to the UUID');
  const starts = events.filter((e) => e.event_type === 'session_start');
  assert.equal(starts.length, 1);
  assert.ok(starts[0].client_timestamp, 'session_start carries a timestamp');
  assert.equal(starts[0].agent_type, 'antigravity');
});

test('parseAntigravityFile: steps map to the taxonomy (user_prompt, tool_use, generic), none dropped', () => {
  const events = parseAntigravityFile(buildFixture('22222222-0000-0000-0000-000000000000'));
  assert.ok(events.some((e) => e.event_type === 'user_prompt'), 'user_input → user_prompt');
  const tool = events.find((e) => e.event_type === 'tool_use');
  assert.ok(tool, 'run_command → tool_use');
  assert.equal(tool!.tool_name, 'run_command');
  // unknown oneof (kind undefined) becomes a generic `response`, not dropped
  const generic = events.find((e) => e.event_type === 'response' && (e.metadata as { kind: unknown }).kind === null);
  assert.ok(generic, 'unmapped step ingested as generic response');
});

test('parseAntigravityFile: llm_response carries cache-net tokens + cost from CortexGeneratorMetadata', () => {
  const events = parseAntigravityFile(buildFixture('33333333-0000-0000-0000-000000000000'));
  const llm = events.find((e) => e.event_type === 'llm_response');
  assert.ok(llm, 'a generation produced an llm_response');
  assert.equal(llm!.model, 'gemini-pro-default');
  assert.equal(llm!.tokens_in, 21016); // system(1016) + input(20000)
  assert.equal(llm!.tokens_out, 3000); // total output (incl. reasoning)
  assert.equal(llm!.cache_read_tokens, 8000); // cached, not folded into tokens_in
  assert.equal((llm!.metadata as { thoughts_tokens: number }).thoughts_tokens, 2500);
  assert.ok(llm!.cost_usd !== undefined && llm!.cost_usd > 0, 'priced (gemini-pro-default)');
});

test('discoverAntigravityLogs: finds conversation DBs nested under subdirectories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-home-'));
  const conversations = path.join(home, 'conversations');
  const nested = path.join(conversations, 'project-x', '2026-07');
  fs.mkdirSync(nested, { recursive: true });
  const flat = path.join(conversations, 'flat.db');
  const deep = path.join(nested, 'deep.db');
  fs.writeFileSync(flat, '');
  fs.writeFileSync(deep, '');
  fs.writeFileSync(path.join(nested, 'notes.txt'), 'ignore me');

  const found = discoverAntigravityLogs(home);
  assert.ok(found.includes(flat), 'top-level .db discovered');
  assert.ok(found.includes(deep), 'nested .db discovered (recursive)');
  assert.ok(!found.some((f) => f.endsWith('.txt')), 'non-.db files excluded');
});

test('stepKindToEvent: explicit and generic mappings', () => {
  assert.deepEqual(stepKindToEvent('user_input'), { type: 'user_prompt' });
  assert.deepEqual(stepKindToEvent('run_command'), { type: 'tool_use', toolName: 'run_command' });
  assert.deepEqual(stepKindToEvent('write_to_file'), { type: 'file_change', toolName: 'write_to_file' });
  assert.deepEqual(stepKindToEvent('browser_click_element'), { type: 'tool_use', toolName: 'browser_click_element' });
  assert.deepEqual(stepKindToEvent('finish'), { type: 'session_end' });
  assert.deepEqual(stepKindToEvent(undefined), { type: 'response' });
});
