import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { parseIntegerOption } from '../src/cli/args.js';
import { createConfig } from '../src/config.js';
import { sliceWithoutSplittingSurrogates } from '../src/util/text.js';
import { buildObservationTree } from '../src/trace-quality/on-demand.js';
import type { TraceQualityObservation } from '../src/api/v2/types.js';

describe('parseIntegerOption', () => {
  test('rejects a value with trailing characters', () => {
    assert.throws(() => parseIntegerOption('100xyz', '--limit'), /Invalid --limit: 100xyz/);
    assert.throws(() => parseIntegerOption('1.5', '--limit'), /Invalid --limit/);
  });

  test('accepts plain and negative integers', () => {
    assert.equal(parseIntegerOption('100', '--limit'), 100);
    assert.equal(parseIntegerOption('-3', '--offset'), -3);
  });
});

describe('AGENTMONITOR_PORT', () => {
  test('falls back to the default above the highest TCP port', () => {
    assert.equal(createConfig({ AGENTMONITOR_PORT: '99999' }).port, 3141);
    assert.equal(createConfig({ AGENTMONITOR_PORT: '65535' }).port, 65535);
  });
});

describe('sliceWithoutSplittingSurrogates', () => {
  test('stops before a pair that would be cut in half', () => {
    const text = 'a'.repeat(499) + '😀tail';
    const preview = sliceWithoutSplittingSurrogates(text, 500);
    assert.equal(preview, 'a'.repeat(499));
    assert.ok(!/[\uD800-\uDBFF]$/.test(preview));
  });

  test('keeps a pair that fits and leaves short text alone', () => {
    assert.equal(sliceWithoutSplittingSurrogates('a😀b', 3), 'a😀');
    assert.equal(sliceWithoutSplittingSurrogates('short', 500), 'short');
  });
});

describe('buildObservationTree', () => {
  function observation(id: string, parent: string | null): TraceQualityObservation {
    return { id, parent_observation_id: parent } as TraceQualityObservation;
  }

  test('a self-parented observation becomes a root, not its own child', () => {
    const tree = buildObservationTree([observation('a', 'a')]);
    assert.deepEqual(tree.map(node => node.id), ['a']);
    assert.equal(tree[0].children.length, 0);
  });

  test('a parent cycle keeps every member in the tree', () => {
    const tree = buildObservationTree([observation('a', 'b'), observation('b', 'a'), observation('c', 'a')]);
    const seen: string[] = [];
    const walk = (nodes: typeof tree, depth: number): void => {
      assert.ok(depth < 10, 'the tree is finite');
      for (const node of nodes) { seen.push(node.id); walk(node.children, depth + 1); }
    };
    walk(tree, 0);
    assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  });

  test('ordinary parent links still nest', () => {
    const tree = buildObservationTree([observation('root', null), observation('child', 'root')]);
    assert.deepEqual(tree.map(node => node.id), ['root']);
    assert.deepEqual(tree[0].children.map(node => node.id), ['child']);
  });
});
