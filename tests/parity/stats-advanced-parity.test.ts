/**
 * Black-box parity tests for advanced stats endpoints.
 * Runs unchanged against both TypeScript and Rust runtimes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getJson,
  postJson,
  uniqueSession,
} from './helpers/runtime.js';

function uniqueToolName(): string {
  return `ParityTool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueProject(): string {
  return `parity-cost-project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueModel(): string {
  return `parity-model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

test('GET /api/stats/tools returns expected shape', async () => {
  const res = await getJson('/api/stats/tools');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.tools), true);
  if (body.tools.length > 0) {
    const sample = body.tools[0];
    assert.equal(typeof sample.tool_name, 'string');
    assert.equal(typeof sample.total_calls, 'number');
    assert.equal(typeof sample.error_count, 'number');
    assert.equal(typeof sample.error_rate, 'number');
    assert.ok(sample.avg_duration_ms === null || typeof sample.avg_duration_ms === 'number');
    assert.equal(typeof sample.by_agent, 'object');
  }
});

test('GET /api/stats/tools includes unique ingested tool analytics', async () => {
  const toolName = uniqueToolName();

  const session = uniqueSession();
  await postJson('/api/events', {
    session_id: session,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: toolName,
    status: 'success',
    duration_ms: 120,
  });
  await postJson('/api/events', {
    session_id: session,
    agent_type: 'claude_code',
    event_type: 'tool_use',
    tool_name: toolName,
    status: 'error',
    duration_ms: 300,
  });

  const res = await getJson('/api/stats/tools?agent_type=claude_code&since=1970-01-01T00:00:00Z');
  assert.equal(res.status, 200);
  const body = await res.json();

  const row = body.tools.find((r: { tool_name: string }) => r.tool_name === toolName);
  assert.ok(row, `missing tool row for ${toolName}`);
  assert.ok(row.total_calls >= 2);
  assert.ok(row.error_count >= 1);
  assert.ok(typeof row.by_agent.claude_code === 'number');
});

test('GET /api/stats/cost returns expected shape', async () => {
  const res = await getJson('/api/stats/cost');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.timeline), true);
  assert.equal(Array.isArray(body.by_project), true);
  assert.equal(Array.isArray(body.by_model), true);
});

test('GET /api/stats/cost includes unique project and model costs', async () => {
  const session = uniqueSession();
  const project = uniqueProject();
  const model = uniqueModel();

  await postJson('/api/events', {
    session_id: session,
    agent_type: 'codex',
    event_type: 'llm_response',
    project,
    model,
    tokens_in: 100,
    tokens_out: 200,
    cost_usd: 0.75,
    source: 'api',
  });
  await postJson('/api/events', {
    session_id: session,
    agent_type: 'codex',
    event_type: 'llm_response',
    project,
    model,
    tokens_in: 50,
    tokens_out: 100,
    cost_usd: 0.25,
    source: 'api',
  });

  const res = await getJson('/api/stats/cost?agent_type=codex&since=1970-01-01T00:00:00Z&limit=50');
  assert.equal(res.status, 200);
  const body = await res.json();

  const byProject = body.by_project.find((row: { project: string }) => row.project === project);
  assert.ok(byProject, `missing project row for ${project}`);
  assert.ok(byProject.cost_usd >= 1.0);

  const byModel = body.by_model.find((row: { model: string }) => row.model === model);
  assert.ok(byModel, `missing model row for ${model}`);
  assert.ok(byModel.cost_usd >= 1.0);

  assert.ok(body.timeline.length >= 1);
});

test('GET /api/stats/usage-monitor returns native provider quota snapshots', async () => {
  await postJson('/api/provider-quotas/claude/statusline', {
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1_776_933_923 },
      seven_day: { used_percentage: 34, resets_at: 1_777_416_387 },
    },
  });
  await postJson('/api/provider-quotas/codex', {
    status: 'available',
    source: 'parity-test',
    plan_type: 'plus',
    primary: { used_percent: 5, resets_at: '2026-04-23T08:45:23Z', window_minutes: 300 },
    secondary: { used_percent: 24, resets_at: '2026-04-28T22:46:27Z', window_minutes: 10080 },
    credits: { has_credits: false, unlimited: false, balance: '0' },
  });

  const res = await getJson('/api/stats/usage-monitor');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body), true);

  const claude = body.find((row: { provider: string }) => row.provider === 'claude');
  assert.ok(claude, 'missing claude_code usage row');
  assert.equal(claude.agent_type, 'claude_code');
  assert.equal(claude.status, 'available');
  assert.equal(claude.primary.used_percent, 12);
  assert.equal(claude.primary.window_minutes, 300);
  assert.equal(claude.secondary.used_percent, 34);
  assert.equal(claude.secondary.window_minutes, 10080);

  const codex = body.find((row: { provider: string }) => row.provider === 'codex');
  assert.ok(codex, 'missing codex usage row');
  assert.equal(codex.agent_type, 'codex');
  assert.equal(codex.status, 'available');
  assert.equal(codex.plan_type, 'plus');
  assert.equal(codex.primary.used_percent, 5);
  assert.equal(codex.secondary.used_percent, 24);
  assert.equal(codex.credits.has_credits, false);
});
