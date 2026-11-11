/**
 * Lets only the newest request write its result. A response can land after a
 * newer request was sent (a filter changed, a different item was opened), and
 * writing it then shows data for a question the user no longer asked.
 *
 * `begin()` starts a request that supersedes every earlier one. `join()` starts
 * one that runs alongside the current request without superseding it, such as a
 * page appended to what the current request loaded. Each returns `isCurrent`:
 * check it after every `await`, and write state (including errors and loading
 * flags) only while it is true. `invalidate()` makes every request in flight
 * stale, as when the view is cleared.
 */
export interface LatestRequest {
  begin(): () => boolean;
  join(): () => boolean;
  invalidate(): void;
}

export function latestRequest(): LatestRequest {
  let generation = 0;
  const checker = (): (() => boolean) => {
    const mine = generation;
    return () => mine === generation;
  };
  return {
    begin() {
      generation += 1;
      return checker();
    },
    join: checker,
    invalidate() {
      generation += 1;
    },
  };
}
