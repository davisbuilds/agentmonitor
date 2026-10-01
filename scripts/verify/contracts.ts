import assert from 'node:assert/strict';

export const scenarios = [
  {
    id: 'live-session',
    description: 'Synthetic transcript → compiled watcher/projection → API → live browser update without reload',
    route: '/app/#live',
    fixture: 'claude-live-v1',
    checks: ['initial-api', 'initial-browser', 'updated-api', 'updated-browser'],
    limits: ['Claude JSONL only; no external harness hooks, provider authentication, or installed-service checks'],
  },
  {
    id: 'usage',
    description: 'Known usage totals → compiled API → browser cards and project filter; separate API and UI timings',
    route: '/app/#usage?from=2026-07-01&to=2026-07-31',
    fixture: 'usage-1000-v1',
    checks: ['totals-api', 'totals-browser', 'filtered-api', 'filtered-browser'],
    limits: ['Synthetic 1,000-event fixture; timings are observations, not a production performance guarantee'],
  },
] as const;

export type Scenario = typeof scenarios[number]['id'];
export type Check = { name: string; status: 'passed' | 'failed' | 'not_run'; detail?: string };
export const usageExpected = {
  all: { total_usage_events: 1000, total_input_tokens: 100000, total_output_tokens: 20000, total_cost_usd: 10 },
  alpha: { total_usage_events: 600, total_input_tokens: 60000, total_output_tokens: 12000, total_cost_usd: 6 },
};

export function scenarioById(id: string) {
  const scenario = scenarios.find(entry => entry.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}. Use list.`);
  return scenario;
}

export function assertUsage(actual: unknown, expected: typeof usageExpected.all): void {
  assert.ok(actual && typeof actual === 'object', 'Missing usage summary');
  for (const [key, value] of Object.entries(expected)) {
    assert.equal((actual as Record<string, unknown>)[key], value, `Usage ${key}`);
  }
}
