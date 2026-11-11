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
