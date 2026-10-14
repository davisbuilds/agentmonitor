import { describe, expect, it } from 'vitest';
import { liveDotStatus } from './status';

describe('liveDotStatus', () => {
  it('maps live session states onto the status dot', () => {
    expect(liveDotStatus('live')).toBe('active');
    expect(liveDotStatus('active')).toBe('active');
    expect(liveDotStatus('idle')).toBe('idle');
    expect(liveDotStatus('ended')).toBe('ended');
    expect(liveDotStatus(null)).toBe('ended');
  });
});
