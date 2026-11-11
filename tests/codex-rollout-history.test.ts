import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { codexRolloutDependencyStamp, createCodexRolloutInventory, resolveCodexRolloutHistory } from '../src/util/codex-rollout-history.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-history-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
let sequence = 0;
const nativeId = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const dir = path.join(tempDir, String(++sequence));
  fs.mkdirSync(dir);
  return (physicalId: number, owner: number, body: unknown[], meta: Record<string, unknown> = {}, compressed = false) => {
    const header = { type: 'session_meta', ordinal: (meta.history_base as { end_ordinal_exclusive?: number } | undefined)?.end_ordinal_exclusive ?? 0,
      payload: { id: nativeId(owner), history_mode: 'paginated', cwd: '/synthetic', ...meta } };
    const bytes = Buffer.from([header, ...body].map(record => JSON.stringify(record)).join('\n') + '\n');
    const file = path.join(dir, `rollout-2026-11-01T00-00-00-${nativeId(physicalId)}.jsonl${compressed ? '.zst' : ''}`);
    fs.writeFileSync(file, compressed ? zstdCompressSync(bytes) : bytes);
    return { file, bytes };
  };
}
const item = (ordinal: number, text: string) => ({ type: 'event_msg', ordinal, payload: { type: 'user_message', message: text } });
const position = (id: number, end: number, bytes: Buffer) => ({ thread_id: nativeId(id), end_ordinal_exclusive: end, end_byte_offset: bytes.length });

test('expands bounded history using physical rollout ids while keeping current metadata and origin offsets', () => {
  const write = fixture();
  const root = write(1, 1, [item(1, 'retained café')]);
  fs.appendFileSync(root.file, JSON.stringify(item(2, 'abandoned')) + '\n');
  const reverted = write(2, 1, [item(3, 'replacement')], { history_base: position(1, 2, root.bytes) });
  const current = write(3, 1, [item(5, 'continuation')], { history_base: position(2, 4, reverted.bytes) });
  const inventory = createCodexRolloutInventory([root.file, reverted.file, current.file]);
  const result = resolveCodexRolloutHistory(current.file, { inventory });
  assert.deepEqual(result.records.filter(r => r.value.type !== 'session_meta').map(r => r.value.payload), [
    item(1, 'retained café').payload, item(3, 'replacement').payload, item(5, 'continuation').payload,
  ]);
  assert.equal(result.records[0].filePath, current.file);
  assert.equal(result.sessionId, nativeId(1));
  assert.equal(result.rolloutId, nativeId(3));
  assert.equal(result.ownFromLine, 3);
  assert.equal(result.prefixLineCount, 2);
  assert.deepEqual(result.lines, result.content.trimEnd().split('\n'));
  assert.equal(result.records[1].endByteOffset, root.bytes.length);
  assert.deepEqual(result.segments[0].bytes, root.bytes);
  assert.equal(inventory.bySessionId.get(nativeId(1))?.length, 3);
});

test('compressed ancestor cutoffs address decoded bytes and allow declared child forks', () => {
  const write = fixture();
  const root = write(11, 11, [item(1, '親')], {}, true);
  const child = write(12, 12, [item(3, 'child')], { forked_from_id: nativeId(11), history_base: position(11, 2, root.bytes) });
  const result = resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] });
  assert.equal(result.records[1].sessionId, nativeId(11));
  assert.equal(result.records[1].inherited, true);
  assert.equal(result.records[2].inherited, false);
  assert.equal(result.records[0].sessionId, nativeId(12));
});

test('fails closed on missing ancestors, invalid byte cutoffs, ordinal mismatch and undeclared foreign owner', () => {
  const write = fixture();
  const root = write(21, 21, [item(1, 'keep')]);
  for (const [label, base, extra] of [
    ['missing', position(99, 2, root.bytes), {}],
    ['byte', { ...position(21, 2, root.bytes), end_byte_offset: root.bytes.length - 2 }, {}],
    ['ordinal', position(21, 7, root.bytes), {}],
    ['foreign', position(21, 2, root.bytes), {}],
  ] as const) {
    const owner = label === 'foreign' ? 25 : 21;
    const child = write(22, owner, [item(base.end_ordinal_exclusive + 1, label)], { history_base: base, ...extra });
    assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] }), /history|rollout|ordinal|boundary|owner|thread/i, label);
  }
});

test('rejects cycles, ambiguous ids, excessive depth and byte budget', () => {
  const write = fixture();
  const root = write(31, 31, [item(1, 'root')]);
  const child = write(32, 31, [item(3, 'child')], { history_base: position(31, 2, root.bytes) });
  const siblingDir = path.join(path.dirname(root.file), 'duplicate');
  fs.mkdirSync(siblingDir);
  const duplicate = path.join(siblingDir, path.basename(root.file));
  fs.copyFileSync(root.file, duplicate);
  assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, duplicate, child.file] }), /ambiguous/i);
  assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file], maxDepth: 1 }), /depth/i);
  assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file], maxBytes: 1 }), /byte|size|budget/i);
  const cycle = write(33, 31, [], { history_base: { thread_id: nativeId(33), end_ordinal_exclusive: 1, end_byte_offset: 1 } });
  assert.throws(() => resolveCodexRolloutHistory(cycle.file, { filePaths: [cycle.file] }), /cycle/i);
});

test('inventory preserves malformed pointer owners, skips unrelated invalid files and refreshes changed headers', () => {
  const write = fixture();
  const root = write(41, 41, [item(1, 'root')], { session_id: nativeId(99) });
  const malformed = write(42, 41, [], { history_base: { thread_id: nativeId(41), end_byte_offset: -1 } });
  const invalid = path.join(path.dirname(root.file), 'ordinary.jsonl');
  fs.writeFileSync(invalid, 'not a Codex header\n');
  const inventory = createCodexRolloutInventory([root.file, malformed.file, invalid]);
  assert.equal(inventory.bySessionId.get(nativeId(41))?.length, 2);
  assert.equal(inventory.bySessionId.has(nativeId(99)), false);
  assert.equal(inventory.errors.size, 2);
  assert.ok(inventory.entries.find(entry => entry.filePath === malformed.file)?.historyError);
  assert.throws(() => resolveCodexRolloutHistory(malformed.file, { inventory }), /malformed history_base/);
  const updated = root.bytes.toString('utf8').replace(nativeId(41), nativeId(43));
  fs.writeFileSync(root.file, updated);
  assert.equal(createCodexRolloutInventory([root.file]).entries[0].sessionId, nativeId(43));
});

test('one frozen read supplies metadata and records; malformed excluded suffix is never parsed', () => {
  const write = fixture();
  const root = write(51, 51, [item(1, 'retained')]);
  fs.appendFileSync(root.file, '{"partial":');
  const child = write(52, 51, [item(3, 'child')], { history_base: position(51, 2, root.bytes) });
  const frozen = new Map([[root.file, root.bytes], [child.file, child.bytes]]);
  const reads: string[] = [];
  const result = resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file], readFile: file => {
    reads.push(file);
    return frozen.get(file)!;
  } });
  assert.deepEqual(reads, [child.file, root.file]);
  assert.equal(result.lines.length, 3);
  assert.equal(result.ownContent, child.bytes.toString('utf8'));
  assert.equal(resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] }).lines.length, 3);
  fs.appendFileSync(child.file, '{"partial":');
  assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] }), /incomplete source record/);
});

test('inventory prefers coexisting plain files and retains physical header timestamps', () => {
  const write = fixture();
  const root = write(61, 61, [item(1, 'root')]);
  const header = JSON.parse(root.bytes.toString('utf8').split('\n')[0]);
  header.timestamp = '2026-11-02T00:00:00Z';
  header.payload.timestamp = '2026-11-01T00:00:00Z';
  const bytes = Buffer.from(JSON.stringify(header) + '\r\n' + JSON.stringify(item(1, 'root')) + '\r\n');
  fs.writeFileSync(root.file, bytes);
  fs.writeFileSync(root.file + '.zst', zstdCompressSync(bytes));
  const inventory = createCodexRolloutInventory([root.file + '.zst', root.file, root.file]);
  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.entries[0].timestamp, '2026-11-02T00:00:00Z');
  const child = write(62, 61, [item(3, 'child')], { history_base: position(61, 2, bytes) });
  const resolved = resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] });
  assert.deepEqual(resolved.segments[0].bytes, bytes);
  assert.equal(resolved.records[1].endByteOffset, bytes.length);
});


test('dependency stamp includes cross-native ancestors and can commit exact frozen stamps', () => {
  const write = fixture();
  const parent = write(71, 71, [item(1, 'parent')]);
  const child = write(72, 72, [item(3, 'child')], { forked_from_id: nativeId(71), history_base: position(71, 2, parent.bytes) });
  const inventory = createCodexRolloutInventory([parent.file, child.file]);
  const members = inventory.bySessionId.get(nativeId(72))!;
  const snapshots = new Map(inventory.entries.map(entry => {
    const stat = fs.statSync(entry.filePath, { bigint: true });
    return [entry.filePath, { mtime: stat.mtimeNs.toString(), size: Number(stat.size) }] as const;
  }));
  const first = codexRolloutDependencyStamp(members, inventory);
  assert.equal(first, codexRolloutDependencyStamp(members, inventory, snapshots));
  fs.appendFileSync(parent.file, JSON.stringify(item(2, 'later parent record')) + '\n');
  assert.notEqual(first, codexRolloutDependencyStamp(members, inventory));
  assert.equal(first, codexRolloutDependencyStamp(members, inventory, snapshots), 'commit uses stamps read with parsed bytes');
  assert.equal(snapshots.get(child.file)?.size, fs.statSync(child.file).size, 'child is unchanged');
  assert.throws(() => codexRolloutDependencyStamp(members, inventory, new Map()), /missing frozen dependency snapshot/);
  assert.throws(() => codexRolloutDependencyStamp(members, createCodexRolloutInventory([child.file])), /missing source rollout/);
});


test('dependency stamp rejects ambiguous roots, invalid references and cycles', () => {
  const write = fixture();
  const root = write(81, 81, [item(1, 'root')]);
  const duplicateDir = path.join(path.dirname(root.file), 'duplicate');
  fs.mkdirSync(duplicateDir);
  const duplicate = path.join(duplicateDir, path.basename(root.file));
  fs.copyFileSync(root.file, duplicate);
  const ambiguous = createCodexRolloutInventory([root.file, duplicate]);
  assert.throws(() => codexRolloutDependencyStamp(ambiguous.entries, ambiguous), /ambiguous/);
  assert.throws(() => resolveCodexRolloutHistory(root.file, { inventory: ambiguous }), /ambiguous/);
  const malformed = write(82, 81, [], { history_base: { thread_id: nativeId(81) } });
  const invalidInventory = createCodexRolloutInventory([root.file, malformed.file]);
  assert.throws(() => codexRolloutDependencyStamp(invalidInventory.entries, invalidInventory), /malformed history_base/);
  const cycle = write(83, 81, [], { history_base: { thread_id: nativeId(83), end_ordinal_exclusive: 1, end_byte_offset: 1 } });
  const cycleInventory = createCodexRolloutInventory([cycle.file]);
  assert.throws(() => codexRolloutDependencyStamp(cycleInventory.entries, cycleInventory), /cycle/);
});

for (const compressed of [false, true]) {
  test(`repeated same-native metadata preserves the first header and physical records in ${compressed ? 'compressed' : 'plain'} roots`, () => {
    const write = fixture();
    const repeated = { type: 'session_meta', ordinal: 2, payload: {
      id: nativeId(91), history_mode: 'paginated', history_base: null, cwd: '/synthetic/resumed', originator: 'resumed',
    } };
    const root = write(91, 91, [item(1, 'before resume'), repeated, item(3, 'after resume')], {}, compressed);
    const result = resolveCodexRolloutHistory(root.file, { filePaths: [root.file] });
    assert.equal(result.records.length, 4);
    assert.equal(result.records[0].value.payload && (result.records[0].value.payload as Record<string, unknown>).cwd, '/synthetic');
    assert.equal(result.segments[0].meta.cwd, '/synthetic', 'first metadata remains authoritative');
    assert.deepEqual(result.records.map(record => record.value.ordinal), [0, 1, 2, 3]);
    assert.equal(result.records[2].raw, JSON.stringify(repeated));
    assert.equal(result.records[2].filePath, root.file);
    assert.equal(result.records[2].inherited, false);
    assert.equal(result.records[3].endByteOffset, root.bytes.length);
    assert.deepEqual(result.segments[0].bytes, root.bytes);
    const child = write(92, 91, [item(5, 'new page')], { history_base: position(91, 4, root.bytes) });
    const expanded = resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] });
    assert.equal(expanded.records.filter(record => record.value.type === 'session_meta').length, 1, 'all ancestor metadata is removed');
    assert.deepEqual(expanded.records.map(record => record.value.ordinal), [4, 1, 3, 5]);
    assert.equal(expanded.segments[0].records.length, 4, 'physical ancestor origins retain repeated headers');
    assert.equal(expanded.ownFromLine, 3);
  });
}

test('continuation metadata can repeat the same history bookmark with reordered fields', () => {
  const write = fixture();
  const root = write(101, 101, [item(1, 'prefix')]);
  const base = position(101, 2, root.bytes);
  const repeated = { type: 'session_meta', ordinal: 4, payload: {
    id: nativeId(101), history_mode: 'paginated', cwd: '/synthetic/resumed',
    history_base: { end_byte_offset: base.end_byte_offset, thread_id: base.thread_id, end_ordinal_exclusive: base.end_ordinal_exclusive },
  } };
  const child = write(102, 101, [item(3, 'before resume'), repeated, item(5, 'after resume')], { history_base: base });
  const result = resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] });
  assert.deepEqual(result.records.map(record => record.value.ordinal), [2, 1, 3, 4, 5]);
  assert.equal(result.ownFromLine, 2);
  assert.equal(result.segments[1].meta.cwd, '/synthetic');
});

test('repeated metadata with conflicting owner or physical history fails closed', () => {
  const write = fixture();
  const root = write(111, 111, [item(1, 'prefix')]);
  const base = position(111, 2, root.bytes);
  const conflicts: Record<string, unknown>[] = [
    { id: nativeId(999) },
    { history_base: null },
    { history_base: { ...base, thread_id: nativeId(999) } },
    { history_base: { ...base, end_ordinal_exclusive: 3 } },
    { history_base: { ...base, end_byte_offset: base.end_byte_offset - 1 } },
    { history_base: { ...base, end_byte_offset: 'invalid' } },
  ];
  for (const conflict of conflicts) {
    const child = write(112, 111, [{ type: 'session_meta', ordinal: 3, payload: {
      id: nativeId(111), history_mode: 'paginated', history_base: base, ...conflict,
    } }], { history_base: base });
    assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [root.file, child.file] }), /history|metadata/);
  }
  const changedRoot = write(113, 113, [{ type: 'session_meta', ordinal: 1, payload: {
    id: nativeId(113), history_mode: 'paginated', history_base: base,
  } }]);
  assert.throws(() => resolveCodexRolloutHistory(changedRoot.file, { filePaths: [root.file, changedRoot.file] }), /history|metadata/);
});

for (const compressed of [false, true]) {
  test(`full-history roots accept repeated native metadata without ordinals when ${compressed ? 'compressed' : 'plain'}`, () => {
    const write = fixture();
    const repeated = { type: 'session_meta', payload: { id: nativeId(121), history_mode: 'full', cwd: '/synthetic/resumed' } };
    const root = write(121, 121, [{ type: 'event_msg', payload: { type: 'user_message', message: 'before' } }, repeated], { history_mode: 'full' }, compressed);
    const lines = root.bytes.toString('utf8').trimEnd().split('\n').map(line => {
      const value = JSON.parse(line);
      delete value.ordinal;
      return JSON.stringify(value);
    });
    const bytes = Buffer.from(lines.join('\n') + '\n');
    fs.writeFileSync(root.file, compressed ? zstdCompressSync(bytes) : bytes);
    const result = resolveCodexRolloutHistory(root.file, { filePaths: [root.file] });
    assert.equal(result.records.length, 3);
    assert.equal(result.segments[0].meta.history_mode, 'full');
    assert.equal(result.segments[0].meta.cwd, '/synthetic');
    assert.equal(result.records[2].raw, JSON.stringify(repeated));
    assert.equal(result.records[2].endByteOffset, bytes.length);
    assert.deepEqual(result.segments[0].bytes, bytes);
    assert.ok(result.records.every(record => record.value.ordinal === undefined));
  });
}

for (const declaration of ['parent_thread_id', 'forked_from_id', 'thread_spawn'] as const) {
  test(`copied subagent parent metadata is accepted only in its explicit inherited prefix via ${declaration}`, () => {
    const write = fixture();
    const parentId = nativeId(131);
    const copied = { type: 'session_meta', ordinal: 1, payload: {
      id: parentId, history_mode: 'paginated', cwd: '/synthetic/parent',
      // This is the parent's bookmark, retained as context without replacing
      // the child's absent history_base or requiring that unrelated file.
      history_base: { thread_id: nativeId(999), end_ordinal_exclusive: 5, end_byte_offset: 100 },
    } };
    const childMeta = {
      subagent_history_start_ordinal: 3,
      source: { subagent: { thread_spawn: declaration === 'thread_spawn' ? { parent_thread_id: parentId } : {} } },
      ...(declaration === 'thread_spawn' ? {} : { [declaration]: parentId }),
    };
    const child = write(132, 132, [copied, item(2, 'copied parent context'), item(3, 'child work')], childMeta, declaration === 'thread_spawn');
    const result = resolveCodexRolloutHistory(child.file, { filePaths: [child.file] });
    assert.equal(result.sessionId, nativeId(132));
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].historyBase, undefined);
    assert.equal(result.segments[0].meta.cwd, '/synthetic');
    assert.equal(result.records[1].raw, JSON.stringify(copied));
    assert.equal(result.records[1].sessionId, nativeId(132), 'origin still identifies the physical child file');
    assert.equal(result.records[1].filePath, child.file);
    assert.deepEqual(result.records.map(record => record.value.ordinal), [0, 1, 2, 3]);
    assert.equal(result.records[3].endByteOffset, child.bytes.length);
    assert.deepEqual(result.segments[0].bytes, child.bytes);
  });
}

test('copied foreign metadata requires a declared parent, subagent source and proven inherited ordinal', () => {
  const write = fixture();
  const meta = {
    history_mode: 'full', parent_thread_id: nativeId(141), subagent_history_start_ordinal: 3,
    source: { subagent: { thread_spawn: { parent_thread_id: nativeId(141) } } },
  };
  const cases: { label: string; ordinal?: number; owner?: number; overrides?: Record<string, unknown> }[] = [
    { label: 'at own boundary', ordinal: 3 },
    { label: 'after own boundary', ordinal: 4 },
    { label: 'missing ordinal' },
    { label: 'fractional ordinal', ordinal: 1.5 },
    { label: 'undeclared foreign owner', ordinal: 1, owner: 999 },
    { label: 'missing boundary', ordinal: 1, overrides: { subagent_history_start_ordinal: undefined } },
    { label: 'invalid boundary', ordinal: 1, overrides: { subagent_history_start_ordinal: '3' } },
    { label: 'ordinary conversation', ordinal: 1, overrides: { source: 'cli' } },
  ];
  for (const entry of cases) {
    const foreign = { type: 'session_meta', ordinal: entry.ordinal, payload: { id: nativeId(entry.owner ?? 141), history_mode: 'full' } };
    const child = write(142, 142, [foreign], { ...meta, ...entry.overrides });
    assert.throws(() => resolveCodexRolloutHistory(child.file, { filePaths: [child.file] }), /conflicting session metadata owner/, entry.label);
  }
});
