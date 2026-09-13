import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before, beforeEach } from 'node:test';
import { main } from '../src/cli.js';

class CaptureStream extends Writable {
  output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

let tempDir = '';
let claudeDir = '';
let dbPath = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let initSchema: typeof import('../src/db/schema.js').initSchema;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let getDb: typeof import('../src/db/connection.js').getDb;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-contracts-'));
  claudeDir = path.join(tempDir, 'claude');
  dbPath = path.join(tempDir, 'contracts.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  process.env.AGENTMONITOR_USAGE_BUDGETS_PATH = path.join(tempDir, 'budgets.json');
  process.env.AGENTMONITOR_SKILL_CATALOG_DIRS = path.join(tempDir, 'skills');
  delete process.env.AGENTMONITOR_WAREHOUSE_DSN;

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ closeDb, getDb } = await import('../src/db/connection.js'));
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  initSchema();
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(claudeDir, 'projects', 'project-a'), { recursive: true });
  const activeDb = getDb();
  assert.equal(
    path.resolve(activeDb.name),
    path.resolve(dbPath),
    'destructive CLI fixture must be connected to its temporary database',
  );
  activeDb.exec(`
    DELETE FROM session_trace_summary;
    DELETE FROM pinned_messages;
    DELETE FROM tool_calls;
    DELETE FROM messages;
    DELETE FROM session_items;
    DELETE FROM session_turns;
    DELETE FROM browsing_sessions;
    DELETE FROM sessions;
    DELETE FROM insights;
    DELETE FROM events;
    DELETE FROM import_state;
  `);
  seedContractData();
  seedArtifactData();
});

function seedContractData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, integration_mode, fidelity, capabilities_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    'agentmonitor',
    'codex',
    'Contract session',
    '2026-06-15T10:00:00.000Z',
    null,
    2,
    1,
    'claude-jsonl',
    'full',
    '{"tool_analytics":"full","history":"full","search":"full","live_items":"full"}',
  );

  const messageId = Number(db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    0,
    'assistant',
    'Used Bash',
    '2026-06-15T10:00:30.000Z',
    0,
    1,
    9,
  ).lastInsertRowid);

  db.prepare(`
    INSERT INTO tool_calls (message_id, session_id, tool_name, category, tool_use_id, input_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, 'contract-session', 'Bash', 'Shell', 'tool-1', '{"command":"pwd"}');

  db.prepare(`
    INSERT INTO tool_calls (message_id, session_id, tool_name, category, tool_use_id, input_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, 'contract-session', 'Skill', 'Other', 'tool-2', '{"skill":"test-strategy"}');

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, project, created_at, client_timestamp,
      model, cost_usd, source, tool_name, duration_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-usage-1',
    'contract-session',
    'codex',
    'llm_response',
    'success',
    100,
    50,
    10,
    0,
    'agentmonitor',
    '2026-06-15 10:00:00',
    '2026-06-15T10:00:00.000Z',
    'gpt-5.4',
    0.001,
    'import',
    null,
    null,
    'evt-reprice',
    'contract-session',
    'codex',
    'llm_response',
    'success',
    25,
    10,
    0,
    0,
    'agentmonitor',
    '2026-06-15 10:01:00',
    '2026-06-15T10:01:00.000Z',
    'gpt-5.4',
    null,
    'api',
    null,
    null,
  );

}

function seedArtifactData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO insights (
      kind, title, prompt, content, date_from, date_to, project, agent, provider, model,
      analytics_summary_json, analytics_coverage_json, usage_summary_json, usage_coverage_json, input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'overview',
    'Contract insight',
    'Summarize the contract fixture.',
    '# Contract insight\n\nThe fixture is healthy.',
    '2026-06-15',
    '2026-06-15',
    'agentmonitor',
    'codex',
    'openai',
    'gpt-5.4',
    JSON.stringify({ total_sessions: 1, total_messages: 2 }),
    JSON.stringify({ matching_sessions: 1 }),
    JSON.stringify({ total_cost_usd: 0.001 }),
    JSON.stringify({ matching_events: 2 }),
    JSON.stringify({ analytics_activity: [], usage_daily: [] }),
  );
}

function seedBenchmarkData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      project, created_at, client_timestamp, model, cost_usd, source, study_id, study, duration_ms, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'benchmark-contract-1',
    'benchmark-contract-1',
    'codex',
    'llm_response',
    'success',
    100,
    50,
    'artifact-task',
    '2026-06-15 12:00:00',
    '2026-06-15T12:00:00.000Z',
    'gpt-5.4',
    0.01,
    'benchmark',
    'contract-study-id',
    'contract-study',
    1000,
    JSON.stringify({
      task: 'artifact-task',
      trial: 1,
      score: 0.9,
      success: true,
      canonical_model: 'gpt-5.4',
      reasoning_effort: 'high',
      is_open_model: false,
      suite: 'contract-suite',
      cost_source: 'captured',
      workspace_changed: true,
    }),
  );
}

function seedSessionAndLiveDetailData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, parent_session_id, relationship_type, integration_mode,
      fidelity, capabilities_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-child',
    'agentmonitor',
    'codex',
    'Child contract session',
    '2026-06-15T10:05:00.000Z',
    '2026-06-15T10:06:00.000Z',
    1,
    1,
    'contract-session',
    'subagent',
    'claude-jsonl',
    'summary',
    '{"tool_analytics":"none","history":"summary","search":"summary","live_items":"summary"}',
  );

  const messageId = Number((db.prepare(
    'SELECT id FROM messages WHERE session_id = ? ORDER BY ordinal LIMIT 1',
  ).get('contract-session') as { id: number }).id);
  db.prepare(`
    INSERT INTO pinned_messages (session_id, message_id, message_ordinal, created_at)
    VALUES (?, ?, ?, ?)
  `).run('contract-session', messageId, 0, '2026-06-15T10:02:00.000Z');

  db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    'codex',
    'turn-contract-1',
    'completed',
    'Contract turn',
    '2026-06-15T10:00:00.000Z',
    '2026-06-15T10:01:00.000Z',
    '2026-06-15T10:00:00.000Z',
  );

}

function seedMonitorData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (
      id, agent_id, agent_type, project, branch, status, started_at, last_event_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    'codex-agent',
    'codex',
    'agentmonitor',
    'main',
    'active',
    '2026-06-15T10:00:00.000Z',
    '2026-06-15T10:02:00.000Z',
    '{"mode":"headless"}',
  );

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, tool_name, status, tokens_in,
      tokens_out, branch, project, duration_ms, created_at, client_timestamp,
      metadata, model, cost_usd, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-monitor-tool',
    'contract-session',
    'codex',
    'tool_use',
    'Bash',
    'success',
    5,
    2,
    'main',
    'agentmonitor',
    25,
    '2026-06-15 10:02:00',
    '2026-06-15T10:02:00.000Z',
    '{"command":"pwd"}',
    'gpt-5.4',
    0.0001,
    'api',
  );
}

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function eventCost(eventId: string): number | null {
  return (getDb().prepare('SELECT cost_usd FROM events WHERE event_id = ?').get(eventId) as { cost_usd: number | null }).cost_usd;
}

test('reporting commands preserve JSON data and coverage contracts', async () => {
  const daily = await runCli(['usage', 'daily', '--json']);
  assert.equal(daily.exitCode, 0, daily.stderr);
  const dailyJson = JSON.parse(daily.stdout) as { data: Array<{ date: string }>; coverage?: { metric_scope: string } };
  assert.equal(dailyJson.data[0]?.date, '2026-06-15');
  assert.equal(dailyJson.coverage?.metric_scope, 'event_usage');

  const models = await runCli(['usage', 'models', '--json']);
  assert.equal(models.exitCode, 0, models.stderr);
  const modelsJson = JSON.parse(models.stdout) as { data: Array<{ model: string }>; coverage?: { usage_events: number } };
  assert.equal(modelsJson.data[0]?.model, 'gpt-5.4');
  assert.equal(modelsJson.coverage?.usage_events, 2);

  const projects = await runCli(['usage', 'projects', '--json']);
  assert.equal(projects.exitCode, 0, projects.stderr);
  const projectsJson = JSON.parse(projects.stdout) as { data: Array<{ project: string }>; coverage?: { usage_sessions: number } };
  assert.equal(projectsJson.data[0]?.project, 'agentmonitor');
  assert.equal(projectsJson.coverage?.usage_sessions, 1);

  const tools = await runCli(['analytics', 'tools', '--json']);
  assert.equal(tools.exitCode, 0, tools.stderr);
  const toolsJson = JSON.parse(tools.stdout) as { data: Array<{ tool_name: string }>; coverage?: { metric_scope: string } };
  assert.equal(toolsJson.data[0]?.tool_name, 'Bash');
  assert.equal(toolsJson.coverage?.metric_scope, 'tool_analytics_capable');

  const traces = await runCli(['quality', 'traces', '--json']);
  assert.equal(traces.exitCode, 0, traces.stderr);
  const tracesJson = JSON.parse(traces.stdout) as { data: unknown[]; coverage?: { matching_traces: number } };
  assert.ok(Array.isArray(tracesJson.data));
  assert.equal(typeof tracesJson.coverage?.matching_traces, 'number');
});

test('usage overview and facets preserve the exact UI query contracts', async () => {
  const params = {
    date_from: '2026-06-15',
    date_to: '2026-06-15',
    project: 'agentmonitor',
    agent: 'codex',
    model: 'gpt-5.4',
    provider: 'openai',
    tier: 'standard',
  };
  const args = [
    '--date-from', params.date_from,
    '--date-to', params.date_to,
    '--project', params.project,
    '--agent', params.agent,
    '--model', params.model,
    '--provider', params.provider,
    '--tier', params.tier,
    '--json',
  ];

  const overview = await runCli(['usage', 'overview', ...args]);
  assert.equal(overview.exitCode, 0, overview.stderr);
  assert.equal(overview.stderr, '');

  const facets = await runCli(['usage', 'facets', ...args]);
  assert.equal(facets.exitCode, 0, facets.stderr);
  assert.equal(facets.stderr, '');

  const { getUsageFacets, getUsageOverview } = await import('../src/db/v2-queries.js');
  const overviewJson = JSON.parse(overview.stdout) as ReturnType<typeof getUsageOverview>;
  const facetsJson = JSON.parse(facets.stdout) as ReturnType<typeof getUsageFacets>;
  assert.deepEqual(overviewJson, getUsageOverview(params));
  assert.deepEqual(facetsJson, getUsageFacets(params));
  assert.equal(overviewJson.summary.total_usage_events, 2);
  assert.equal(overviewJson.models[0]?.model, 'gpt-5.4');
  assert.deepEqual(facetsJson.projects, ['agentmonitor']);
  assert.deepEqual(facetsJson.models, ['gpt-5.4']);
  assert.deepEqual(Object.keys(overviewJson).sort(), [
    'agents', 'coverage', 'daily', 'models', 'models_daily', 'projects', 'summary', 'tiers', 'top_sessions',
  ]);
  assert.deepEqual(Object.keys(facetsJson).sort(), [
    'agents', 'models', 'projects', 'providers', 'tiers',
  ]);
});

test('all Analytics UI reads have exact CLI JSON contracts', async () => {
  const params = {
    date_from: '2026-06-15',
    date_to: '2026-06-15',
    project: 'agentmonitor',
    agent: 'codex',
  };
  const args = [
    '--date-from', params.date_from,
    '--date-to', params.date_to,
    '--project', params.project,
    '--agent', params.agent,
    '--json',
  ];
  const responses = await import('../src/analytics/responses.js');
  const expected = new Map<string, unknown>([
    ['activity', responses.getAnalyticsActivityResponse(params)],
    ['projects', responses.getAnalyticsProjectsResponse(params)],
    ['agents', responses.getAnalyticsAgentsResponse(params)],
    ['velocity', responses.getAnalyticsVelocityResponse(params)],
    ['hour-of-week', responses.getAnalyticsHourOfWeekResponse(params)],
    ['skills daily', responses.getAnalyticsSkillsDailyResponse(params)],
    ['skills health', responses.getAnalyticsSkillHealthResponse(params)],
  ]);

  for (const [command, payload] of expected) {
    const result = await runCli(['analytics', ...command.split(' '), ...args]);
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    assert.equal(result.stderr, '', command);
    const actual = JSON.parse(result.stdout) as { consultations?: { asOf: string } };
    if (command === 'skills health') {
      actual.consultations!.asOf = (payload as { consultations: { asOf: string } }).consultations.asOf;
    }
    assert.deepEqual(actual, payload, command);
  }

  assert.equal((expected.get('activity') as { data: unknown[] }).data.length, 1);
  assert.equal((expected.get('hour-of-week') as { data: unknown[] }).data.length, 168);
  assert.equal((expected.get('skills daily') as { data: unknown[] }).data.length, 1);
  assert.equal((expected.get('skills health') as { data: unknown[] }).data.length, 1);
});

test('trace detail and observations preserve the exact UI query contracts', async () => {
  const traces = await runCli(['quality', 'traces', '--json']);
  assert.equal(traces.exitCode, 0, traces.stderr);
  const traceId = (JSON.parse(traces.stdout) as { data: Array<{ id: string }> }).data[0]?.id;
  assert.ok(traceId, 'fixture should project a trace');

  const detail = await runCli(['quality', 'trace', traceId, '--json']);
  assert.equal(detail.exitCode, 0, detail.stderr);
  assert.equal(detail.stderr, '');

  const observations = await runCli([
    'quality', 'observations', traceId, '--limit', '1', '--offset', '1', '--json',
  ]);
  assert.equal(observations.exitCode, 0, observations.stderr);
  assert.equal(observations.stderr, '');

  const quality = await import('../src/trace-quality/on-demand.js');
  assert.deepEqual(JSON.parse(detail.stdout), quality.getSessionTraceDetail(traceId));
  assert.deepEqual(
    JSON.parse(observations.stdout),
    quality.listSessionObservations(traceId, { limit: 1, offset: 1 }),
  );
  assert.ok((JSON.parse(observations.stdout) as { total: number }).total > 1);

  for (const command of ['trace', 'observations']) {
    const missing = await runCli(['quality', command, 'missing-trace', '--json']);
    assert.equal(missing.exitCode, 4, `${command}: ${missing.stderr}`);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Trace not found/);
  }
});

test('insight reads preserve the exact UI query contracts', async () => {
  const params = {
    date_from: '2026-06-15',
    date_to: '2026-06-15',
    project: 'agentmonitor',
    agent: 'codex',
    kind: 'overview' as const,
    limit: 1,
  };
  const list = await runCli([
    'insights', 'list',
    '--date-from', params.date_from,
    '--date-to', params.date_to,
    '--project', params.project,
    '--agent', params.agent,
    '--kind', params.kind,
    '--limit', String(params.limit),
    '--json',
  ]);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.equal(list.stderr, '');

  const { getInsight } = await import('../src/db/v2-queries.js');
  const { getInsightsListResponse } = await import('../src/insights/responses.js');
  const expectedList = getInsightsListResponse(params);
  assert.deepEqual(JSON.parse(list.stdout), expectedList);
  assert.equal(expectedList.data.length, 1);

  const insightId = expectedList.data[0]!.id;
  const show = await runCli(['insights', 'show', String(insightId), '--json']);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.deepEqual(JSON.parse(show.stdout), getInsight(insightId));

  const invalidKind = await runCli(['insights', 'list', '--kind', 'invalid']);
  assert.equal(invalidKind.exitCode, 2);
  assert.match(invalidKind.stderr, /Invalid --kind: invalid/);

  const missing = await runCli(['insights', 'show', '999999', '--json']);
  assert.equal(missing.exitCode, 4);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Insight not found/);
});

test('benchmark and metadata reads preserve the exact UI query contracts', async () => {
  seedBenchmarkData();
  const { getBenchmarkStudies, getBenchmarkStudy, getDistinctProjects, getDistinctAgents } =
    await import('../src/db/v2-queries.js');

  const studies = await runCli(['benchmarks', 'list', '--json']);
  assert.equal(studies.exitCode, 0, studies.stderr);
  assert.deepEqual(JSON.parse(studies.stdout), { data: getBenchmarkStudies() });
  assert.equal((JSON.parse(studies.stdout) as { data: unknown[] }).data.length, 1);

  const study = await runCli(['benchmarks', 'show', 'contract-study-id', '--json']);
  assert.equal(study.exitCode, 0, study.stderr);
  assert.deepEqual(JSON.parse(study.stdout), getBenchmarkStudy('contract-study-id'));

  const missing = await runCli(['benchmarks', 'show', 'missing-study', '--json']);
  assert.equal(missing.exitCode, 4);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Benchmark study not found/);

  const projects = await runCli(['projects', 'list', '--json']);
  assert.equal(projects.exitCode, 0, projects.stderr);
  assert.deepEqual(JSON.parse(projects.stdout), { data: getDistinctProjects() });
  assert.deepEqual(JSON.parse(projects.stdout), { data: ['agentmonitor'] });

  const agents = await runCli(['agents', 'list', '--json']);
  assert.equal(agents.exitCode, 0, agents.stderr);
  assert.deepEqual(JSON.parse(agents.stdout), { data: getDistinctAgents() });
  assert.deepEqual(JSON.parse(agents.stdout), { data: ['codex'] });
});

test('remaining session and Live reads preserve the exact UI query contracts', async () => {
  seedSessionAndLiveDetailData();
  const queries = await import('../src/db/v2-queries.js');

  const activity = await runCli(['sessions', 'activity', 'contract-session', '--json']);
  assert.equal(activity.exitCode, 0, activity.stderr);
  assert.deepEqual(JSON.parse(activity.stdout), queries.getSessionActivity('contract-session'));
  assert.ok((JSON.parse(activity.stdout) as { total_messages: number }).total_messages > 0);

  const children = await runCli(['sessions', 'children', 'contract-session', '--json']);
  assert.equal(children.exitCode, 0, children.stderr);
  assert.deepEqual(JSON.parse(children.stdout), { data: queries.getSessionChildren('contract-session') });
  assert.equal((JSON.parse(children.stdout) as { data: unknown[] }).data.length, 1);

  const pins = await runCli(['sessions', 'pins', 'contract-session', '--json']);
  assert.equal(pins.exitCode, 0, pins.stderr);
  assert.deepEqual(
    JSON.parse(pins.stdout),
    { data: queries.listPinnedMessages({ session_id: 'contract-session' }) },
  );
  assert.equal((JSON.parse(pins.stdout) as { data: unknown[] }).data.length, 1);

  const settings = await runCli(['live', 'settings', '--json']);
  assert.equal(settings.exitCode, 0, settings.stderr);
  const { getLiveSettingsResponse } = await import('../src/live/responses.js');
  assert.deepEqual(JSON.parse(settings.stdout), getLiveSettingsResponse());

  const liveSession = await runCli(['live', 'show', 'contract-session', '--json']);
  assert.equal(liveSession.exitCode, 0, liveSession.stderr);
  assert.deepEqual(JSON.parse(liveSession.stdout), queries.getLiveSession('contract-session'));

  const turns = await runCli(['live', 'turns', 'contract-session', '--json']);
  assert.equal(turns.exitCode, 0, turns.stderr);
  assert.deepEqual(JSON.parse(turns.stdout), { data: queries.getSessionTurns('contract-session') });
  assert.equal((JSON.parse(turns.stdout) as { data: unknown[] }).data.length, 1);

  for (const command of [
    ['sessions', 'activity'],
    ['sessions', 'pins'],
    ['live', 'show'],
    ['live', 'turns'],
  ]) {
    const missing = await runCli([...command, 'missing-session', '--json']);
    assert.equal(missing.exitCode, 4, `${command.join(' ')}: ${missing.stderr}`);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Session not found/);
  }
});

test('all Monitor REST reads preserve the exact UI query contracts', async () => {
  seedMonitorData();
  const queries = await import('../src/db/v2-queries.js');

  const statsParams = { agent: 'codex', since: '2026-06-15' };
  const stats = await runCli(['monitor', 'stats', '--agent', 'codex', '--since', '2026-06-15', '--json']);
  assert.equal(stats.exitCode, 0, stats.stderr);
  assert.deepEqual(JSON.parse(stats.stdout), queries.getMonitorStats(statsParams));
  assert.ok((JSON.parse(stats.stdout) as { total_events: number }).total_events > 0);

  const eventParams = {
    agent: 'codex',
    event_type: 'tool_use',
    tool_name: 'Bash',
    session_id: 'contract-session',
    branch: 'main',
    model: 'gpt-5.4',
    source: 'api',
    since: '2026-06-15',
    until: '2026-06-16',
    limit: 1,
    offset: 0,
  };
  const events = await runCli([
    'monitor', 'events', '--agent', eventParams.agent, '--event-type', eventParams.event_type,
    '--tool-name', eventParams.tool_name, '--session-id', eventParams.session_id,
    '--branch', eventParams.branch, '--model', eventParams.model, '--source', eventParams.source,
    '--since', eventParams.since, '--until', eventParams.until,
    '--limit', String(eventParams.limit), '--offset', String(eventParams.offset), '--json',
  ]);
  assert.equal(events.exitCode, 0, events.stderr);
  assert.deepEqual(JSON.parse(events.stdout), queries.listMonitorEvents(eventParams));
  assert.equal((JSON.parse(events.stdout) as { events: unknown[] }).events.length, 1);

  const sessionParams = {
    exclude_status: 'active',
    project: 'agentmonitor',
    agent: 'codex',
    date_from: '2026-06-15',
    date_to: '2026-06-16',
    limit: 1,
  };
  const sessions = await runCli([
    'monitor', 'sessions', '--exclude-status', sessionParams.exclude_status,
    '--project', sessionParams.project, '--agent', sessionParams.agent,
    '--date-from', sessionParams.date_from, '--date-to', sessionParams.date_to,
    '--limit', String(sessionParams.limit), '--json',
  ]);
  assert.equal(sessions.exitCode, 0, sessions.stderr);
  assert.deepEqual(JSON.parse(sessions.stdout), queries.listMonitorSessions(sessionParams));
  assert.equal((JSON.parse(sessions.stdout) as { sessions: unknown[] }).sessions.length, 1);

  const filters = await runCli(['monitor', 'filter-options', '--json']);
  assert.equal(filters.exitCode, 0, filters.stderr);
  assert.deepEqual(JSON.parse(filters.stdout), queries.getMonitorFilterOptions());
  assert.ok((JSON.parse(filters.stdout) as { tool_names: string[] }).tool_names.includes('Bash'));

  const toolParams = {
    project: 'agentmonitor',
    agent: 'codex',
    date_from: '2026-06-15',
    date_to: '2026-06-16',
  };
  const tools = await runCli([
    'monitor', 'tools', '--project', toolParams.project, '--agent', toolParams.agent,
    '--date-from', toolParams.date_from, '--date-to', toolParams.date_to, '--json',
  ]);
  assert.equal(tools.exitCode, 0, tools.stderr);
  assert.deepEqual(JSON.parse(tools.stdout), { tools: queries.getMonitorToolStats(toolParams) });
  assert.equal((JSON.parse(tools.stdout) as { tools: unknown[] }).tools.length, 1);

  const detail = await runCli(['monitor', 'show', 'contract-session', '--event-limit', '1', '--json']);
  assert.equal(detail.exitCode, 0, detail.stderr);
  assert.deepEqual(JSON.parse(detail.stdout), queries.getMonitorSessionWithEvents('contract-session', 1));
  assert.equal((JSON.parse(detail.stdout) as { events: unknown[] }).events.length, 1);

  const transcript = await runCli(['monitor', 'transcript', 'contract-session', '--json']);
  assert.equal(transcript.exitCode, 0, transcript.stderr);
  assert.deepEqual(JSON.parse(transcript.stdout), queries.getMonitorSessionTranscript('contract-session'));
  assert.ok((JSON.parse(transcript.stdout) as { entries: unknown[] }).entries.length > 0);

  for (const command of ['show', 'transcript']) {
    const missing = await runCli(['monitor', command, 'missing-session', '--json']);
    assert.equal(missing.exitCode, 4, `${command}: ${missing.stderr}`);
    assert.equal(missing.stdout, '');
  }
});

test('analytics overview returns all UI contracts and scopes its top-session limit', async () => {
  getDb().prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, integration_mode, fidelity, capabilities_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session-2',
    'agentmonitor',
    'codex',
    'Short contract session',
    '2026-06-15T11:00:00.000Z',
    '2026-06-15T11:05:00.000Z',
    1,
    1,
    'claude-jsonl',
    'summary',
    '{"tool_analytics":"none","history":"summary","search":"summary","live_items":"summary"}',
  );
  const params = {
    date_from: '2026-06-15',
    date_to: '2026-06-15',
    project: 'agentmonitor',
    agent: 'codex',
  };
  const args = [
    '--date-from', params.date_from,
    '--date-to', params.date_to,
    '--project', params.project,
    '--agent', params.agent,
    '--json',
  ];

  const result = await runCli(['analytics', 'overview', ...args]);
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), [
    'summary', 'activity', 'projects', 'tools', 'skills_daily', 'skills_health',
    'hour_of_week', 'top_sessions', 'velocity', 'agents',
  ]);
  const { getAnalyticsOverview } = await import('../src/analytics/responses.js');
  const expected = getAnalyticsOverview(params);
  (payload.skills_health as { consultations: { asOf: string } }).consultations.asOf =
    expected.skills_health.consultations.asOf;
  assert.deepEqual(payload, expected);

  const limited = await runCli(['analytics', 'overview', ...args, '--top-sessions-limit', '1']);
  assert.equal(limited.exitCode, 0, limited.stderr);
  const limitedPayload = JSON.parse(limited.stdout) as typeof payload & {
    summary: { total_sessions: number };
    top_sessions: { data: unknown[] };
  };
  assert.equal(limitedPayload.summary.total_sessions, 2);
  assert.equal(limitedPayload.top_sessions.data.length, 1);
});

test('analytics overview reads every rollup from one SQLite snapshot', async () => {
  const { getAnalyticsOverview } = await import('../src/analytics/responses.js');
  const { refreshSkillCatalogSnapshots } = await import('../src/db/v2-queries.js');
  refreshSkillCatalogSnapshots();

  const writerScript = `
    import Database from 'better-sqlite3';
    const db = new Database(process.env.AGENTMONITOR_TEST_DB);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const insert = db.prepare(\`
      INSERT INTO browsing_sessions (
        id, project, agent, started_at, message_count, user_message_count,
        integration_mode, fidelity, capabilities_json
      ) VALUES (?, 'agentmonitor', 'codex', '2026-06-15T12:00:00.000Z', 1, 1,
        'claude-jsonl', 'summary',
        '{"tool_analytics":"none","history":"summary","search":"summary","live_items":"summary"}')
    \`);
    process.stdout.write('ready\\n');
    for (let i = 0; i < 300; i += 1) {
      insert.run(\`concurrent-session-\${i}\`);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    db.close();
  `;
  const writer = spawn(process.execPath, ['--input-type=module', '--eval', writerScript], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTMONITOR_TEST_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const writerErrors: Buffer[] = [];
  writer.stderr.on('data', chunk => writerErrors.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject);
    writer.stdout.once('data', () => resolve());
  });

  let mismatch: number[] | null = null;
  try {
    while (writer.exitCode === null) {
      const overview = getAnalyticsOverview({
        date_from: '2026-06-15',
        date_to: '2026-06-15',
        project: 'agentmonitor',
        agent: 'codex',
      });
      const totals = [
        overview.summary.total_sessions,
        overview.summary.coverage.matching_sessions,
        overview.activity.data.reduce((sum, row) => sum + row.sessions, 0),
        overview.projects.data.reduce((sum, row) => sum + row.session_count, 0),
        overview.velocity.total_sessions,
        overview.agents.data.reduce((sum, row) => sum + row.session_count, 0),
      ];
      if (!totals.every(total => total === totals[0])) {
        mismatch = totals;
        break;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    if (writer.exitCode === null) {
      writer.kill();
      await new Promise<void>(resolve => writer.once('close', () => resolve()));
    }
  }

  assert.equal(Buffer.concat(writerErrors).toString(), '');
  assert.equal(mismatch, null, `overview mixed SQLite snapshots: ${mismatch?.join(', ')}`);
});

test('reporting commands reject unsupported filters instead of ignoring them', async () => {
  const analytics = await runCli(['analytics', 'tools', '--limit', '1']);
  assert.equal(analytics.exitCode, 2);
  assert.equal(analytics.stdout, '');
  assert.match(analytics.stderr, /Unknown option: --limit/);

  const overview = await runCli(['analytics', 'overview', '--limit', '1']);
  assert.equal(overview.exitCode, 2);
  assert.equal(overview.stdout, '');
  assert.match(overview.stderr, /Unknown option: --limit/);

  const quality = await runCli(['quality', 'traces', '--min-score', '0']);
  assert.equal(quality.exitCode, 2);
  assert.equal(quality.stdout, '');
  assert.match(quality.stderr, /Unknown option: --min-score/);

  const budgets = await runCli(['usage', 'budgets', '--project', 'agentmonitor']);
  assert.equal(budgets.exitCode, 2);
  assert.equal(budgets.stdout, '');
  assert.match(budgets.stderr, /Unknown option: --project/);

  const metadata = await runCli(['projects', 'list', '--project', 'agentmonitor']);
  assert.equal(metadata.exitCode, 2);
  assert.equal(metadata.stdout, '');
  assert.match(metadata.stderr, /Unknown option: --project/);

  const benchmark = await runCli(['benchmarks', 'list', '--limit', '1']);
  assert.equal(benchmark.exitCode, 2);
  assert.equal(benchmark.stdout, '');
  assert.match(benchmark.stderr, /Unknown option: --limit/);

  const activity = await runCli(['sessions', 'activity', 'contract-session', '--limit', '1']);
  assert.equal(activity.exitCode, 2);
  assert.equal(activity.stdout, '');
  assert.match(activity.stderr, /Unknown option: --limit/);

  const monitorFilters = await runCli(['monitor', 'filter-options', '--agent', 'codex']);
  assert.equal(monitorFilters.exitCode, 2);
  assert.equal(monitorFilters.stdout, '');
  assert.match(monitorFilters.stderr, /Unknown option: --agent/);
});

test('reporting help names every supported filter', async () => {
  const root = await runCli(['--help']);
  assert.equal(root.exitCode, 0, root.stderr);
  for (const command of [
    'analytics overview', 'analytics activity', 'analytics projects', 'analytics agents',
    'analytics velocity', 'analytics hour-of-week', 'analytics skills daily',
    'analytics skills health', 'quality trace', 'quality observations', 'insights list',
    'insights show', 'benchmarks list', 'benchmarks show', 'projects list', 'agents list',
    'sessions activity', 'sessions children', 'sessions pins', 'live settings', 'live show',
    'live turns', 'monitor stats', 'monitor events', 'monitor sessions',
    'monitor filter-options', 'monitor tools', 'monitor show', 'monitor transcript',
    'monitor watch',
  ]) {
    assert.match(root.stdout, new RegExp(command));
  }

  const overview = await runCli(['usage', 'overview', '--help']);
  assert.equal(overview.exitCode, 0, overview.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--model', '--provider', '--tier', '--json']) {
    assert.match(overview.stdout, new RegExp(flag));
  }

  const topSessions = await runCli(['analytics', 'top-sessions', '--help']);
  assert.equal(topSessions.exitCode, 0, topSessions.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--limit', '--json']) {
    assert.match(topSessions.stdout, new RegExp(flag));
  }

  const analyticsOverview = await runCli(['analytics', 'overview', '--help']);
  assert.equal(analyticsOverview.exitCode, 0, analyticsOverview.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--top-sessions-limit', '--json']) {
    assert.match(analyticsOverview.stdout, new RegExp(flag));
  }

  const skillsHealth = await runCli(['analytics', 'skills', 'health', '--help']);
  assert.equal(skillsHealth.exitCode, 0, skillsHealth.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--json']) {
    assert.match(skillsHealth.stdout, new RegExp(flag));
  }

  const quality = await runCli(['quality', 'traces', '--help']);
  assert.equal(quality.exitCode, 0, quality.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--session-id', '--limit', '--offset', '--json']) {
    assert.match(quality.stdout, new RegExp(flag));
  }

  const observations = await runCli(['quality', 'observations', '--help']);
  assert.equal(observations.exitCode, 0, observations.stderr);
  for (const flag of ['--limit', '--offset', '--json']) {
    assert.match(observations.stdout, new RegExp(flag));
  }

  const trace = await runCli(['quality', 'trace', '--help']);
  assert.equal(trace.exitCode, 0, trace.stderr);
  assert.match(trace.stdout, /quality trace <id> \[--json\]/);

  const insights = await runCli(['insights', 'list', '--help']);
  assert.equal(insights.exitCode, 0, insights.stderr);
  for (const flag of ['--date-from', '--date-to', '--project', '--agent', '--kind', '--limit', '--json']) {
    assert.match(insights.stdout, new RegExp(flag));
  }

  const monitorEvents = await runCli(['monitor', 'events', '--help']);
  assert.equal(monitorEvents.exitCode, 0, monitorEvents.stderr);
  for (const flag of [
    '--agent', '--event-type', '--tool-name', '--session-id', '--branch', '--model',
    '--source', '--since', '--until', '--limit', '--offset', '--json',
  ]) {
    assert.match(monitorEvents.stdout, new RegExp(flag));
  }

  const monitorSessions = await runCli(['monitor', 'sessions', '--help']);
  assert.equal(monitorSessions.exitCode, 0, monitorSessions.stderr);
  for (const flag of [
    '--status', '--exclude-status', '--project', '--agent', '--date-from', '--date-to',
    '--limit', '--json',
  ]) {
    assert.match(monitorSessions.stdout, new RegExp(flag));
  }
});

test('invalid date reporting filters exit with invalid usage', async () => {
  const result = await runCli(['usage', 'overview', '--date-from', 'not-a-date']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Invalid --date-from: not-a-date/);
});

test('serve rejects the removed --no-browser flag instead of silently accepting it', async () => {
  // serve never opened a browser, so --no-browser was a no-op that misrepresented
  // the contract. It is now unknown and must fail loudly rather than lie.
  const result = await runCli(['serve', '--no-browser', '--no-portless']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown option: --no-browser/);
});

test('import dry-run reports parse results without writing events or import state', async () => {
  fs.writeFileSync(
    path.join(claudeDir, 'projects', 'project-a', 'dry-run-session.jsonl'),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'dry-run-session',
      model: 'claude-sonnet-4-5-20250929',
      timestamp: '2026-06-15T12:00:00Z',
      usage: { input_tokens: 20, output_tokens: 10 },
    }),
  );
  const beforeEvents = countRows('events');
  const beforeImportState = countRows('import_state');

  const result = await runCli([
    'import',
    '--source',
    'claude-code',
    '--claude-dir',
    claudeDir,
    '--dry-run',
    '--json',
  ]);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; total_files: number; events_found: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.total_files, 1);
  assert.equal(parsed.events_found, 1);
  assert.equal(countRows('events'), beforeEvents);
  assert.equal(countRows('import_state'), beforeImportState);
});

test('cost recalculation dry-run leaves event costs unchanged', async () => {
  assert.equal(eventCost('evt-reprice'), null);

  const result = await runCli(['costs', 'recalc', '--dry-run', '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; scanned: number; updated: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.scanned, 2);
  assert.ok(parsed.updated >= 1);
  assert.equal(eventCost('evt-reprice'), null);
});

test('warehouse publish dry-run reports planned rows without a warehouse DSN', async () => {
  const result = await runCli(['warehouse', 'publish', '--dry-run', '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    dry_run: boolean;
    account: string;
    rows_planned: number;
    rows_suppressed: number;
    statements: string[];
  };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.account, 'local');
  assert.equal(parsed.rows_planned, 1);
  assert.equal(parsed.rows_suppressed, 0);
  assert.ok(parsed.statements.some(statement => statement.includes('INSERT INTO agentmonitor.runs')));
});

test('warehouse publish without dry-run fails clearly when no DSN is configured', async () => {
  const result = await runCli(['warehouse', 'publish']);

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /set AGENTMONITOR_WAREHOUSE_DSN/);
});
