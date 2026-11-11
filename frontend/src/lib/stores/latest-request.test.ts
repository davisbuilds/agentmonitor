import { describe, it, expect } from 'vitest';
import { latestRequest } from './latest-request';

describe('latestRequest', () => {
  it('a newer begin supersedes every earlier request, joined ones included', () => {
    const requests = latestRequest();
    const first = requests.begin();
    const page = requests.join();
    expect(first()).toBe(true);
    expect(page()).toBe(true);

    const second = requests.begin();
    expect(first()).toBe(false);
    expect(page()).toBe(false);
    expect(second()).toBe(true);
  });

  it('a join does not supersede the request it runs beside', () => {
    const requests = latestRequest();
    const tail = requests.begin();
    requests.join();
    expect(tail()).toBe(true);
  });

  it('invalidate makes every request in flight stale', () => {
    const requests = latestRequest();
    const pending = requests.begin();
    requests.invalidate();
    expect(pending()).toBe(false);
    expect(requests.begin()()).toBe(true);
  });
});
