import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  assignModelColors,
  rankModels,
  METRICS,
  OTHER_COLOR,
  SERIES_COLORS,
  TOP_N,
  type ModelDailyPointLike,
} from '../frontend/src/lib/components/usage/model-colors.js';

function slice(model: string, cost: number, tokens: number) {
  return { model, cost_usd: cost, input_tokens: tokens, output_tokens: 0 };
}

function day(...slices: ReturnType<typeof slice>[]): ModelDailyPointLike {
  return { models: slices };
}

/**
 * Cost rank and token rank disagree: `cheap-chatty` is the largest token consumer and
 * the smallest spender, so it leads the Tokens top-5 while ranking dead last by cost.
 *
 * There are deliberately more models here than there are palette colors. Colors used to
 * be assigned to the cost-ranked models, one per hue — so with six or fewer models every
 * model got one by accident and the bug stayed hidden. `cheap-chatty` has to fall outside
 * that cost-ranked window to reproduce it, which is exactly when it rendered in Other's
 * gray despite being a named series.
 */
const divergent: ModelDailyPointLike[] = [
  day(
    slice('opus', 100, 10),
    slice('sonnet', 80, 20),
    slice('gpt-5', 60, 30),
    slice('gemini', 40, 40),
    slice('haiku', 20, 50),
    slice('mini', 10, 60),
    slice('cheap-chatty', 1, 10_000),
  ),
];

describe('usage top models: series selection', () => {
  test('ranks by the selected metric, not always by cost', () => {
    assert.deepEqual(rankModels(divergent, 'cost'), ['opus', 'sonnet', 'gpt-5', 'gemini', 'haiku']);
    assert.ok(rankModels(divergent, 'tokens').includes('cheap-chatty'));
  });

  test('drops models with no volume in the selected metric', () => {
    const points = [day(slice('opus', 5, 0), slice('ghost', 0, 0))];
    assert.deepEqual(rankModels(points, 'cost'), ['opus']);
  });
});

describe('usage top models: color assignment', () => {
  test('a named series is never painted the aggregated Other gray', () => {
    const colors = assignModelColors(divergent);

    for (const metric of METRICS) {
      for (const model of rankModels(divergent, metric)) {
        const color = colors.get(model);
        assert.ok(color, `${model} is displayed under ${metric} but has no color`);
        assert.notEqual(
          color,
          OTHER_COLOR,
          `${model} is a named series under ${metric} but shares the Other gray`,
        );
      }
    }
  });

  test('every series shown together has a distinct color', () => {
    const colors = assignModelColors(divergent);

    for (const metric of METRICS) {
      const shown = rankModels(divergent, metric);
      const used = shown.map(model => colors.get(model));
      assert.equal(
        new Set(used).size,
        shown.length,
        `two series share a color under ${metric}: ${JSON.stringify(used)}`,
      );
    }
  });

  // Color follows the entity, never its rank. A rank-keyed palette would give whichever
  // model leads the current metric SERIES_COLORS[0], repainting survivors on every
  // toggle — so the two metrics' leaders, being different models, must NOT share a hue.
  test('color follows the model, not its rank in the current metric', () => {
    const colors = assignModelColors(divergent);
    const costLeader = rankModels(divergent, 'cost')[0];
    const tokenLeader = rankModels(divergent, 'tokens')[0];

    assert.notEqual(costLeader, tokenLeader, 'fixture must have different leaders per metric');
    assert.notEqual(
      colors.get(costLeader),
      colors.get(tokenLeader),
      'both leaders got the same hue — colors are keyed to rank, not identity',
    );
  });

  test('colors come from the validated palette', () => {
    for (const color of assignModelColors(divergent).values()) {
      assert.ok(SERIES_COLORS.includes(color), `${color} is not in the validated palette`);
    }
  });

  // Worst case: the two metrics' top-N sets are entirely disjoint, so ten distinct
  // models can appear. They are never shown together, so a six-color palette still
  // suffices — but only because sets are colored independently.
  test('disjoint cost and token leaders still resolve within the palette', () => {
    const points = [day(
      ...Array.from({ length: TOP_N }, (_, i) => slice(`costly-${i}`, 100 - i, 1)),
      ...Array.from({ length: TOP_N }, (_, i) => slice(`chatty-${i}`, 0.01, 10_000 - i)),
    )];

    const colors = assignModelColors(points);
    for (const metric of METRICS) {
      const shown = rankModels(points, metric);
      assert.equal(shown.length, TOP_N);
      assert.equal(new Set(shown.map(m => colors.get(m))).size, TOP_N, `collision under ${metric}`);
      assert.ok(shown.every(m => colors.get(m) !== OTHER_COLOR));
    }
  });
});
