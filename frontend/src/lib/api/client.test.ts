// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchLiveSession } from './client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('API errors', () => {
  it('keep the response status, so a missing session reads differently from a failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":"Live session not found"}', { status: 404 }));

    const error = await fetchLiveSession('gone').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toContain('fetchLiveSession failed (404)');
  });
});
