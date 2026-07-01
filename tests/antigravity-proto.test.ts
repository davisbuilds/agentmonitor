import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMessage,
  getVarint,
  decodeStepEnvelope,
  decodeGoogleUsage,
  decodeGeneratorMetadata,
  deriveBillingTokens,
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
function sField(field: number, s: string): number[] {
  return lField(field, [...Buffer.from(s, 'utf-8')]);
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

test('decodeGeneratorMetadata: extracts model + CortexUsage from the real gen_metadata shape', () => {
  // wrapper.1 -> CortexGeneratorMetadata { 19: model, 4: CortexUsage }
  // CortexUsage: 1=system, 2=input(non-cached), 3=output(=thinking+answer), 5=cached, 9=thinking, 10=answer
  const usage = [
    ...vField(1, 1016),
    ...vField(2, 20000),
    ...vField(3, 3000),
    ...vField(5, 8000),
    ...vField(9, 2500),
    ...vField(10, 500),
  ];
  const gm = [...sField(19, 'gemini-pro-default'), ...lField(4, usage)];
  const blob = buf(lField(1, gm));

  const decoded = decodeGeneratorMetadata(blob);
  assert.equal(decoded.model, 'gemini-pro-default');
  assert.ok(decoded.usage);
  assert.equal(decoded.usage!.inputTokens, 20000);
  assert.equal(decoded.usage!.cachedTokens, 8000);
  assert.equal(decoded.usage!.thinkingTokens, 2500);
  // invariant proven across all 21 real records: output == thinking + answer
  assert.equal(
    decoded.usage!.outputTokens,
    decoded.usage!.thinkingTokens + decoded.usage!.answerTokens,
  );
});

test('deriveBillingTokens: honors the cache-inclusive invariant (in + cache additive, non-overlapping)', () => {
  const billing = deriveBillingTokens({
    systemPromptTokens: 1016,
    inputTokens: 20000,
    outputTokens: 3000,
    cachedTokens: 8000,
    thinkingTokens: 2500,
    answerTokens: 500,
  });
  assert.equal(billing.tokensIn, 21016); // system + non-cached input
  assert.equal(billing.cacheReadTokens, 8000); // cached bulk NOT folded into tokensIn
  assert.equal(billing.tokensOut, 3000); // includes reasoning
  assert.equal(billing.thoughtsTokens, 2500);
});

test('decodeGeneratorMetadata: returns empty on a blob without the wrapper', () => {
  assert.deepEqual(decodeGeneratorMetadata(buf([...vField(2, 5)])), {});
});
