import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMessage,
  getVarint,
  decodeStepEnvelope,
  decodeGoogleUsage,
} from '../src/import/antigravity/proto.js';

// --- minimal protobuf encoder, for building deterministic fixtures ---
function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let byte = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) byte |= 0x80;
    out.push(byte);
  } while (big > 0);
  return out;
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}
function vField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)];
}
function lField(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}
const buf = (arr: number[]) => Buffer.from(arr);

test('decodeMessage: reads varint and length-delimited fields by number', () => {
  const bytes = buf([...vField(1, 150), ...lField(2, [...vField(1, 7)])]);
  const fields = decodeMessage(bytes);
  assert.equal(getVarint(fields, 1), 150);
  const sub = decodeMessage(fields.get(2)![0].bytes!);
  assert.equal(getVarint(sub, 1), 7);
});

test('decodeMessage: tolerates trailing garbage without throwing', () => {
  const bytes = buf([...vField(1, 5), 0xff, 0xff]);
  assert.doesNotThrow(() => decodeMessage(bytes));
});

test('decodeStepEnvelope: extracts type, status, kind from the oneof, metadata presence', () => {
  // gemini_coder.Step: type=1 -> 28 (run_command), status=4 -> 3,
  // metadata=5 present, oneof payload field 28 (run_command) present.
  const stepPayload = buf([
    ...vField(1, 28),
    ...vField(4, 3),
    ...lField(5, [...vField(1, 1)]), // CortexStepMetadata (opaque here)
    ...lField(28, [...vField(1, 1)]), // run_command payload (opaque)
  ]);
  const step = decodeStepEnvelope(stepPayload);
  assert.equal(step.type, 28);
  assert.equal(step.status, 3);
  assert.equal(step.kind, 'run_command');
  assert.equal(step.hasMetadata, true);
});

test('decodeStepEnvelope: unknown kind falls back to generic marker, never throws', () => {
  const stepPayload = buf([...vField(1, 9999), ...lField(9999, [0x01])]);
  const step = decodeStepEnvelope(stepPayload);
  assert.equal(step.kind, undefined); // no known oneof field set
  assert.equal(step.type, 9999);
});

test('decodeGoogleUsage: maps pinned UsageMetadata field numbers', () => {
  // prompt=1000, candidates=200, total=1500, cached=800, thoughts=300
  const usage = buf([
    ...vField(1, 1000),
    ...vField(2, 200),
    ...vField(3, 1500),
    ...vField(5, 800),
    ...vField(14, 300),
  ]);
  const u = decodeGoogleUsage(usage);
  assert.equal(u.promptTokenCount, 1000);
  assert.equal(u.candidatesTokenCount, 200);
  assert.equal(u.totalTokenCount, 1500);
  assert.equal(u.cachedContentTokenCount, 800);
  assert.equal(u.thoughtsTokenCount, 300);
});
