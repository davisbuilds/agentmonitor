import { describe, expect, it } from 'vitest';
import { frictionDescription, frictionLabel } from './friction-signals';

describe('friction signals', () => {
  it('names each signal by what happened and how often', () => {
    expect(frictionLabel({ kind: 'failure_streak', count: 4, ordinal: 12 })).toBe('4 failures in a row');
    expect(frictionLabel({ kind: 'interruptions', count: 1, ordinal: 3 })).toBe('Interrupted');
    expect(frictionLabel({ kind: 'interruptions', count: 3, ordinal: 3 })).toBe('Interrupted 3×');
  });

  it('says where the chip opens the session', () => {
    expect(frictionDescription({ kind: 'failure_streak', count: 4, ordinal: 12 }))
      .toBe('Tool calls failed 4 times in a row, the longest run in the session. Opens at message 12.');
    expect(frictionDescription({ kind: 'interruptions', count: 2, ordinal: 3 }))
      .toBe('You stopped the agent 2 times. Opens at message 3, the first time.');
    expect(frictionDescription({ kind: 'failure_streak', count: 3, ordinal: null })).toMatch(/Opens the session\.$/);
  });
});
