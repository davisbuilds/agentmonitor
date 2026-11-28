import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import Database from 'better-sqlite3';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type {
  getAnalyticsDelegation as getAnalyticsDelegationFn,
  getAnalyticsGitActivity as getAnalyticsGitActivityFn,
  getAnalyticsSkillConsultations as getAnalyticsSkillConsultationsFn,
  getAnalyticsSkillsDaily as getAnalyticsSkillsDailyFn,
  getAnalyticsSkillsHealth as getAnalyticsSkillsHealthFn,
  getAnalyticsSummary as getAnalyticsSummaryFn,
  getAnalyticsTools as getAnalyticsToolsFn,
  getLiveSession as getLiveSessionFn,
  getMonitorToolStats as getMonitorToolStatsFn,
  getSessionChildren as getSessionChildrenFn,
  getSessionGitActivity as getSessionGitActivityFn,
  listBrowsingSessions as listBrowsingSessionsFn,
} from '../src/db/v2-queries.js';
import type { syncGitActivity as syncGitActivityFn } from '../src/git/activity.js';
import type { getSessionToolTiming as getSessionToolTimingFn } from '../src/monitor/session-tool-timing.js';
import type { getSessionSkillContext as getSessionSkillContextFn } from '../src/skills/session-skill-context.js';
import type { assertContentFree as assertContentFreeFn, mapSummaryToRunRow as mapSummaryToRunRowFn } from '../src/warehouse/runs-export.js';
import type { listWarehouseSessionTraceSummaries as listWarehouseSummariesFn } from '../src/warehouse/source.js';
import type { syncAllAntigravityFiles as syncAllAgrFn } from '../src/watcher/index.js';

function varint(n: number): number[] {
  const out: number[] = [];
  let big = n;
  do {
    let b = big & 0x7f;
    big = Math.floor(big / 128);
    if (big > 0) b |= 0x80;
    out.push(b);
  } while (big > 0);
  return out;
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const vField = (f: number, n: number) => [...tag(f, 0), ...varint(n)];
const lField = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b];
const sField = (f: number, s: string) => lField(f, [...Buffer.from(s, 'utf-8')]);

interface ProtoToolCallSpec {
  id: string;
  name: string;
  argsJson: string;
}

const chatToolCallBytes = (tc: ProtoToolCallSpec) => [
  ...sField(1, tc.id),
  ...sField(2, tc.name),
  ...sField(3, tc.argsJson),
];

function stepBlob(options: {
  type: number;
  oneof: number;
  status?: number;
  plannerToolCalls?: ProtoToolCallSpec[];
}): Buffer {
  const payloadBytes = options.oneof === 20 && options.plannerToolCalls?.length
    ? options.plannerToolCalls.flatMap(tc => lField(7, chatToolCallBytes(tc)))
    : vField(1, 1);
  return Buffer.from([
    ...vField(1, options.type),
    ...vField(4, options.status ?? 3),
    ...lField(5, vField(1, 1)),
    ...lField(options.oneof, payloadBytes),
  ]);
}

function metaBlob(secs: number, toolCall?: ProtoToolCallSpec): Buffer {
  return Buffer.from([
    ...lField(1, vField(1, secs)),
    ...(toolCall ? lField(4, chatToolCallBytes(toolCall)) : []),
  ]);
}

const genBlob = (model: string, inp: number, out: number, cached: number, createdSecs: number) =>
  Buffer.from(lField(1, [
    ...sField(19, model),
    ...lField(4, [...vField(1, 1020), ...vField(2, inp), ...vField(3, out), ...vField(5, cached), ...vField(9, 0), ...vField(10, out)]),
    ...lField(9, lField(4, vField(1, createdSecs))),
  ]));

function writeConversationDb(
  dbPath: string,
  options: {
    steps?: Array<{
      idx: number;
      type: number;
      oneof: number;
      status?: number;
      tsSecs: number;
      plannerToolCalls?: ProtoToolCallSpec[];
      stepToolCall?: ProtoToolCallSpec;
    }>;
    generations?: Array<{ model: string; inp: number; out: number; cached: number; createdSecs: number }>;
  } = {},
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB);');
  db.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER, data BLOB);');
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(dbPath));
  db.exec('DELETE FROM steps; DELETE FROM gen_metadata;');
  const steps = options.steps ?? [{ idx: 0, type: 14, oneof: 19, tsSecs: 1795651200 }];
  const insStep = db.prepare('INSERT INTO steps(idx, step_type, status, step_payload, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const s of steps) {
    insStep.run(
      s.idx,
      s.type,
      s.status ?? 3,
      stepBlob({ type: s.type, oneof: s.oneof, status: s.status, plannerToolCalls: s.plannerToolCalls }),
      metaBlob(s.tsSecs, s.stepToolCall),
    );
  }
  const insGen = db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)');
  (options.generations ?? []).forEach((g, idx) => {
    insGen.run(idx, genBlob(g.model, g.inp, g.out, g.cached, g.createdSecs));
  });
  db.close();
}

function writeSummaryDb(
  home: string,
  rows: Array<{
    conversation_id: string;
    title?: string;
    preview?: string;
    workspace_uris?: string;
    parent_conversation_id?: string;
    nesting_depth?: number;
    agent_name?: string;
  }>,
): void {
  const summaryPath = path.join(home, 'conversation_summaries.db');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  const db = new Database(summaryPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      agent_name TEXT NOT NULL DEFAULT ''
    );
  `);
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(summaryPath));
  db.exec('DELETE FROM conversation_summaries;');
  const ins = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, workspace_uris,
      parent_conversation_id, nesting_depth, agent_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    ins.run(
      r.conversation_id,
      r.title ?? '',
      r.preview ?? '',
      r.workspace_uris ?? '[]',
      r.parent_conversation_id ?? '',
      r.nesting_depth ?? 0,
      r.agent_name ?? '',
    );
  }
  db.close();
}

function writeTranscript(
  home: string,
  sessionId: string,
  entries: Array<Record<string, unknown>>,
): string {
  const filePath = path.join(home, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function gitRun(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Slice4 Tester',
      GIT_AUTHOR_EMAIL: 'slice4@example.com',
      GIT_COMMITTER_NAME: 'Slice4 Tester',
      GIT_COMMITTER_EMAIL: 'slice4@example.com',
      ...env,
    },
  }).trim();
}

let tempDir = '';
let dbPath = '';
let server: Server;
let baseUrl = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let syncAllAntigravityFiles: typeof syncAllAgrFn;
let getAnalyticsSkillsDaily: typeof getAnalyticsSkillsDailyFn;
let getAnalyticsSkillsHealth: typeof getAnalyticsSkillsHealthFn;
let getAnalyticsSkillConsultations: typeof getAnalyticsSkillConsultationsFn;
let getSessionSkillContext: typeof getSessionSkillContextFn;
let getSessionChildren: typeof getSessionChildrenFn;
let listBrowsingSessions: typeof listBrowsingSessionsFn;
let getLiveSession: typeof getLiveSessionFn;
let getAnalyticsDelegation: typeof getAnalyticsDelegationFn;
let getAnalyticsSummary: typeof getAnalyticsSummaryFn;
let getAnalyticsTools: typeof getAnalyticsToolsFn;
let getMonitorToolStats: typeof getMonitorToolStatsFn;
let getSessionToolTiming: typeof getSessionToolTimingFn;
let syncGitActivity: typeof syncGitActivityFn;
let getAnalyticsGitActivity: typeof getAnalyticsGitActivityFn;
let getSessionGitActivity: typeof getSessionGitActivityFn;
let listWarehouseSessionTraceSummaries: typeof listWarehouseSummariesFn;
let mapSummaryToRunRow: typeof mapSummaryToRunRowFn;
let assertContentFree: typeof assertContentFreeFn;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-slice4-'));
  dbPath = path.join(tempDir, 'monitor.db');
  const catalogDir = path.join(tempDir, 'catalog');
  fs.mkdirSync(path.join(catalogDir, 'diagnose'), { recursive: true });
  fs.writeFileSync(
    path.join(catalogDir, 'diagnose', 'SKILL.md'),
    '---\nname: diagnose\nversion: 1.2.0\n---\nDiagnose bugs.',
    'utf-8',
  );

  process.env.AGENTMONITOR_DB_PATH = dbPath;
  process.env.AGENTMONITOR_TIMEZONE = 'UTC';
  process.env.AGENTMONITOR_SKILL_CATALOG_DIRS = catalogDir;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';

  const conn = await import('../src/db/connection.js');
  getDb = conn.getDb;
  closeDb = conn.closeDb;
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();

  ({ syncAllAntigravityFiles } = await import('../src/watcher/index.js'));
  ({
    getAnalyticsSkillsDaily,
    getAnalyticsSkillsHealth,
    getAnalyticsSkillConsultations,
    getSessionChildren,
    listBrowsingSessions,
    getLiveSession,
    getAnalyticsDelegation,
    getAnalyticsSummary,
    getAnalyticsTools,
    getMonitorToolStats,
    getAnalyticsGitActivity,
    getSessionGitActivity,
  } = await import('../src/db/v2-queries.js'));
  ({ getSessionSkillContext } = await import('../src/skills/session-skill-context.js'));
  ({ getSessionToolTiming } = await import('../src/monitor/session-tool-timing.js'));
  ({ syncGitActivity } = await import('../src/git/activity.js'));
  ({ listWarehouseSessionTraceSummaries } = await import('../src/warehouse/source.js'));
  ({ mapSummaryToRunRow, assertContentFree } = await import('../src/warehouse/runs-export.js'));

  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Antigravity Slice 4: skills, child sessions, Git attribution, and shared identity', () => {
  test('emits verified skill consultations across recognized roots, classifies repeats and compactions, and ignores prose/failed/ambiguous/unrecognized reads', async () => {
    const home = path.join(tempDir, 'agr-skills');
    const sessionId = '40404040-1111-2222-3333-404040404040';
    const repoCwd = path.join(tempDir, 'skill-project');
    fs.mkdirSync(repoCwd, { recursive: true });

    const diagPath = '/Users/example/.gemini/config/skills/diagnose/SKILL.md';
    const builtinPath = '/Users/example/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md';
    const agentsPath = '/Users/example/.agents/skills/test-strategy/SKILL.md';
    const repoLocalPath = path.join(repoCwd, '.agents', 'skills', 'repo-local-skill', 'SKILL.md');
    const unrecognizedPath = '/tmp/random-project/docs/not-a-skill/SKILL.md';
    const failedPath = '/Users/example/.gemini/config/skills/failed-skill/SKILL.md';
    const ambiguousPath = '/Users/example/.gemini/config/skills/ambiguous-skill/SKILL.md';

    const t0 = Date.parse('2026-11-27T10:00:00Z') / 1000;
    const callDiag1: ProtoToolCallSpec = { id: 'call_diag_1', name: 'read_file', argsJson: JSON.stringify({ Path: diagPath }) };
    const callBuiltin: ProtoToolCallSpec = { id: 'call_builtin', name: 'read_file', argsJson: JSON.stringify({ Path: builtinPath }) };
    const callAgents: ProtoToolCallSpec = { id: 'call_agents', name: 'view_file', argsJson: JSON.stringify({ AbsolutePath: agentsPath }) };
    const callRepoLocal: ProtoToolCallSpec = { id: 'call_repo_local', name: 'read_file', argsJson: JSON.stringify({ Path: repoLocalPath }) };
    const callUnrecognized: ProtoToolCallSpec = { id: 'call_unrec', name: 'read_file', argsJson: JSON.stringify({ Path: unrecognizedPath }) };
    const callFailed: ProtoToolCallSpec = { id: 'call_failed', name: 'read_file', argsJson: JSON.stringify({ Path: failedPath }) };
    const callEditSkill: ProtoToolCallSpec = { id: 'call_edit', name: 'edit_file', argsJson: JSON.stringify({ Path: diagPath, Target: 'a', Replacement: 'b' }) };
    const callEchoSkill: ProtoToolCallSpec = { id: 'call_echo', name: 'run_command', argsJson: JSON.stringify({ CommandLine: `echo /Users/example/.gemini/config/skills/echo-only/SKILL.md` }) };
    const callDiag2: ProtoToolCallSpec = { id: 'call_diag_2', name: 'read_file', argsJson: JSON.stringify({ Path: diagPath }) };
    const callDiag3: ProtoToolCallSpec = { id: 'call_diag_3', name: 'read_file', argsJson: JSON.stringify({ Path: diagPath }) };

    writeConversationDb(path.join(home, 'conversations', `${sessionId}.db`), {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: t0 },
        { idx: 1, type: 15, oneof: 20, tsSecs: t0 + 1, plannerToolCalls: [callDiag1, callBuiltin] },
        { idx: 2, type: 132, oneof: 140, tsSecs: t0 + 2, stepToolCall: callDiag1 },
        { idx: 3, type: 132, oneof: 140, tsSecs: t0 + 3, stepToolCall: callBuiltin },
        { idx: 4, type: 15, oneof: 20, tsSecs: t0 + 4, plannerToolCalls: [callAgents, callRepoLocal, callUnrecognized, callFailed, callEditSkill, callEchoSkill] },
        { idx: 5, type: 132, oneof: 140, tsSecs: t0 + 5, stepToolCall: callAgents },
        { idx: 6, type: 132, oneof: 140, tsSecs: t0 + 6, stepToolCall: callRepoLocal },
        { idx: 7, type: 132, oneof: 140, tsSecs: t0 + 7, stepToolCall: callUnrecognized },
        { idx: 8, type: 132, oneof: 140, status: 7, tsSecs: t0 + 8, stepToolCall: callFailed },
        { idx: 9, type: 132, oneof: 140, tsSecs: t0 + 9, stepToolCall: callEditSkill },
        { idx: 10, type: 132, oneof: 140, tsSecs: t0 + 10, stepToolCall: callEchoSkill },
        { idx: 11, type: 15, oneof: 20, tsSecs: t0 + 11 },
        { idx: 12, type: 132, oneof: 140, tsSecs: t0 + 12 },
        { idx: 13, type: 15, oneof: 20, tsSecs: t0 + 13, plannerToolCalls: [callDiag2] },
        { idx: 14, type: 132, oneof: 140, tsSecs: t0 + 14, stepToolCall: callDiag2 },
        { idx: 15, type: 23, oneof: 30, tsSecs: t0 + 15 },
        { idx: 16, type: 15, oneof: 20, tsSecs: t0 + 16, plannerToolCalls: [callDiag3] },
        { idx: 17, type: 132, oneof: 140, tsSecs: t0 + 17, stepToolCall: callDiag3 },
      ],
      generations: [
        { model: 'gemini-4-neon', inp: 1200, out: 180, cached: 3000, createdSecs: t0 + 1 },
      ],
    });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: 'Skill consultation verification',
      workspace_uris: JSON.stringify([`file://${repoCwd}`]),
    }]);
    writeTranscript(home, sessionId, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-27T10:00:00Z',
        content: '<USER_REQUEST>\nDo not read /Users/example/.gemini/config/skills/prose-only/SKILL.md just mention it.\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T10:00:01Z',
        thinking: 'Considering /Users/example/.gemini/config/skills/thinking-only/SKILL.md in prose.',
        content: 'Mentioning /Users/example/.gemini/config/skills/assistant-prose/SKILL.md before calling read_file.',
        tool_calls: [
          { name: 'read_file', args: { Path: diagPath } },
          { name: 'read_file', args: { Path: builtinPath } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:02Z', content: '1: ---\n2: name: diagnose\n---' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:03Z', content: '1: ---\n2: name: antigravity-guide\n---' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T10:00:04Z',
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: agentsPath } },
          { name: 'read_file', args: { Path: repoLocalPath } },
          { name: 'read_file', args: { Path: unrecognizedPath } },
          { name: 'read_file', args: { Path: failedPath } },
          { name: 'edit_file', args: { Path: diagPath, Target: 'a', Replacement: 'b' } },
          { name: 'run_command', args: { CommandLine: 'echo /Users/example/.gemini/config/skills/echo-only/SKILL.md' } },
        ],
      },
      { step_index: 5, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:05Z', content: 'test-strategy body' },
      { step_index: 6, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:06Z', content: 'repo-local body' },
      { step_index: 7, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:07Z', content: 'unrecognized body' },
      { step_index: 8, type: 'GENERIC', status: 'ERROR', error: 'ENOENT: no such file', created_at: '2026-11-27T10:00:08Z', content: 'Error: ENOENT' },
      { step_index: 9, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:09Z', content: 'Edited file' },
      { step_index: 10, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:10Z', content: 'Command exited with code 0.\n/Users/example/.gemini/config/skills/echo-only/SKILL.md' },
      {
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T10:00:11Z',
        tool_calls: [
          { name: 'read_file', args: { Path: ambiguousPath } },
          { name: 'read_file', args: { Path: '/Users/example/other.txt' } },
        ],
      },
      { step_index: 12, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:12Z', content: 'ambiguous unlinked generic receipt' },
      {
        step_index: 13,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T10:00:13Z',
        tool_calls: [{ name: 'read_file', args: { Path: diagPath } }],
      },
      { step_index: 14, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:14Z', content: 'diagnose repeat read' },
      {
        step_index: 15,
        type: 'CHECKPOINT',
        status: 'DONE',
        created_at: '2026-11-27T10:00:15Z',
        content: '# Resuming from a compaction\n\nEarlier messages summarized.',
      },
      {
        step_index: 16,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T10:00:16Z',
        tool_calls: [{ name: 'read_file', args: { Path: diagPath } }],
      },
      { step_index: 17, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T10:00:17Z', content: 'diagnose post-compaction read' },
    ]);

    const db = getDb();
    assert.equal(syncAllAntigravityFiles(db, home).parsed, 1);

    const daily = getAnalyticsSkillsDaily({ agent: 'antigravity', date_from: '2026-11-27', date_to: '2026-11-27' });
    assert.equal(daily.length, 1);
    const bySkill = Object.fromEntries(daily[0].skills.map(s => [s.skill_name, s.count]));
    assert.deepEqual(bySkill, {
      diagnose: 3,
      antigravity_guide: 1,
      'repo-local-skill': 1,
      'test-strategy': 1,
    });
    for (const forbidden of ['prose-only', 'thinking-only', 'assistant-prose', 'not-a-skill', 'failed-skill', 'ambiguous-skill', 'echo-only']) {
      assert.equal(bySkill[forbidden], undefined, `must not emit skill consultation for ${forbidden}`);
    }

    const consultations = getAnalyticsSkillConsultations({
      agent: 'antigravity',
      date_from: '2026-11-27',
      date_to: '2026-11-27',
    });
    const agrHarness = consultations.byHarness.find(h => h.harness === 'antigravity');
    assert.ok(agrHarness);
    assert.equal(agrHarness.detectionSemantics, 'concrete_skill_path');
    const diagRow = agrHarness.skills.find(s => s.name === 'diagnose');
    assert.ok(diagRow);
    assert.equal(diagRow.invocations, 3);
    assert.deepEqual(diagRow.classes, {
      first_read: 1,
      repeat_no_compaction: 1,
      rehydration_after_compaction: 1,
      unclassifiable: 0,
    });
    assert.equal(diagRow.sessionsWithFirstRead, 1);

    const health = getAnalyticsSkillsHealth({ agent: 'antigravity', date_from: '2026-11-27', date_to: '2026-11-27' });
    const diagHealth = health.find(row => row.name === 'diagnose');
    assert.ok(diagHealth);
    assert.equal(diagHealth.invocations, 3);

    const ctx = getSessionSkillContext(db, sessionId);
    assert.ok(ctx);
    assert.equal(ctx.harness, 'antigravity');
    assert.deepEqual(ctx.consultationClassification, { observable: true });
    assert.deepEqual(
      ctx.observations.filter(o => o.kind === 'consultation' && o.skillName === 'diagnose').map(o => o.consultationClass),
      ['first_read', 'repeat_no_compaction', 'rehydration_after_compaction'],
    );
    const apiCtx = await fetch(`${baseUrl}/api/v2/sessions/${sessionId}/skill-context`);
    assert.equal(apiCtx.status, 200);
    const apiBody = await apiCtx.json() as { harness: string; observations: Array<{ kind: string; skillName: string | null }> };
    assert.equal(apiBody.harness, 'antigravity');
    assert.ok(apiBody.observations.some(o => o.kind === 'compaction'));
  });

  test('attributes two distinct children, handles missing parent, and refuses fabricated links on ambiguous or failed receipts', () => {
    const home = path.join(tempDir, 'agr-children');
    const parentId = '50505050-1111-2222-3333-505050505050';
    const childAId = '51515151-1111-2222-3333-515151515151';
    const childBId = '52525252-1111-2222-3333-525252525252';
    const orphanChildId = '53535353-1111-2222-3333-535353535353';
    const unlinkedChildId = '54545454-1111-2222-3333-545454545454';
    const failedChildId = '55555555-1111-2222-3333-555555555555';
    const missingParentId = '59595959-1111-2222-3333-595959595959';

    const t0 = Date.parse('2026-11-27T11:00:00Z') / 1000;
    const invokeA: ProtoToolCallSpec = {
      id: 'call_sub_a',
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ Role: 'Codebase Researcher', TypeName: 'research', Prompt: 'Inspect codebase' }),
    };
    const invokeB: ProtoToolCallSpec = {
      id: 'call_sub_b',
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ Role: 'Verification Engineer', TypeName: 'self', Prompt: 'Run verification' }),
    };
    const invokeFail: ProtoToolCallSpec = {
      id: 'call_sub_fail',
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ Role: 'Failed Worker', TypeName: 'self', Prompt: 'Fail' }),
    };

    writeConversationDb(path.join(home, 'conversations', `${parentId}.db`), {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: t0 },
        { idx: 1, type: 15, oneof: 20, tsSecs: t0 + 1, plannerToolCalls: [invokeA, invokeB] },
        { idx: 2, type: 132, oneof: 140, tsSecs: t0 + 2, stepToolCall: invokeA },
        { idx: 3, type: 132, oneof: 140, tsSecs: t0 + 3, stepToolCall: invokeB },
        { idx: 4, type: 15, oneof: 20, tsSecs: t0 + 4, plannerToolCalls: [invokeFail] },
        { idx: 5, type: 132, oneof: 140, status: 7, tsSecs: t0 + 5, stepToolCall: invokeFail },
        { idx: 6, type: 15, oneof: 20, tsSecs: t0 + 6 },
        { idx: 7, type: 132, oneof: 140, tsSecs: t0 + 7 },
      ],
    });
    writeTranscript(home, parentId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-27T11:00:00Z', content: '<USER_REQUEST>\nDelegate work to two children\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T11:00:01Z',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'Codebase Researcher', TypeName: 'research', Prompt: 'Inspect codebase' } },
          { name: 'invoke_subagent', args: { Role: 'Verification Engineer', TypeName: 'self', Prompt: 'Run verification' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-27T11:00:02Z',
        content: `Created At: 2026-11-27T11:00:02Z\nCreated the following subagent:\n{\n  "conversationId": "${childAId}",\n  "logAbsoluteUri": "file:///tmp/a.jsonl"\n}`,
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-27T11:00:03Z',
        content: `Created At: 2026-11-27T11:00:03Z\nCreated the following subagent:\n{\n  "conversationId":  "${childBId}",\n  "logAbsoluteUri":  "file:///tmp/b.jsonl"\n}`,
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T11:00:04Z',
        tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Failed Worker', TypeName: 'self', Prompt: 'Fail' } }],
      },
      {
        step_index: 5,
        type: 'GENERIC',
        status: 'ERROR',
        error: 'subagent failed to start',
        created_at: '2026-11-27T11:00:05Z',
        content: `{"conversationId": "${failedChildId}"}\nError: subagent failed to start`,
      },
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T11:00:06Z',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'Ambiguous 1', TypeName: 'self' } },
          { name: 'invoke_subagent', args: { Role: 'Ambiguous 2', TypeName: 'self' } },
        ],
      },
      {
        step_index: 7,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-27T11:00:07Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${unlinkedChildId}"\n}`,
      },
    ]);

    for (const [cid, ts, prompt] of [
      [childAId, '2026-11-27T11:00:02Z', 'Child A task'],
      [childBId, '2026-11-27T11:00:03Z', 'Child B task'],
      [orphanChildId, '2026-11-27T11:00:04Z', 'Orphan child task'],
      [unlinkedChildId, '2026-11-27T11:00:08Z', 'Unlinked child task'],
      [failedChildId, '2026-11-27T11:00:05Z', 'Failed child task'],
    ] as const) {
      writeConversationDb(path.join(home, 'conversations', `${cid}.db`), {
        steps: [{ idx: 0, type: 14, oneof: 19, tsSecs: Date.parse(ts) / 1000 }],
      });
      writeTranscript(home, cid, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: ts, content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` },
      ]);
    }

    writeSummaryDb(home, [
      { conversation_id: parentId, title: 'Parent coordinator', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
      { conversation_id: childAId, title: '', parent_conversation_id: parentId, nesting_depth: 1, agent_name: 'research', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
      { conversation_id: childBId, title: '', parent_conversation_id: '', nesting_depth: 0, agent_name: 'self', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
      { conversation_id: orphanChildId, title: '', parent_conversation_id: missingParentId, nesting_depth: 1, agent_name: 'research', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
      { conversation_id: unlinkedChildId, title: 'Independent session', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
      { conversation_id: failedChildId, title: 'Never spawned', workspace_uris: JSON.stringify(['file:///Users/example/Dev/demo-children']) },
    ]);

    const db = getDb();
    assert.equal(syncAllAntigravityFiles(db, home).parsed, 6);

    const linkedCalls = db.prepare(
      'SELECT tool_use_id, subagent_session_id FROM tool_calls WHERE session_id = ? AND tool_name = ? ORDER BY id',
    ).all(parentId, 'invoke_subagent') as Array<{ tool_use_id: string | null; subagent_session_id: string | null }>;
    assert.deepEqual(
      linkedCalls.map(c => [c.tool_use_id, c.subagent_session_id]),
      [
        ['call_sub_a', childAId],
        ['call_sub_b', childBId],
        ['call_sub_fail', null],
        ['antigravity:6:0', null],
        ['antigravity:6:1', null],
      ],
    );

    const children = getSessionChildren(parentId);
    assert.deepEqual(children.map(c => c.id), [childAId, childBId]);
    assert.equal(children[0].title, 'Codebase Researcher');
    assert.equal(children[1].title, 'Verification Engineer');
    assert.equal(children[1].parent_session_id, parentId);
    assert.equal(children[1].relationship_type, 'subagent');

    const liveChildB = getLiveSession(childBId);
    assert.equal(liveChildB?.parent_session_id, parentId);
    assert.equal(liveChildB?.relationship_type, 'subagent');
    assert.equal(liveChildB?.title, 'Verification Engineer');

    const orphanLive = getLiveSession(orphanChildId);
    assert.equal(orphanLive?.parent_session_id, missingParentId);
    assert.equal(orphanLive?.relationship_type, 'subagent');

    const unlinkedLive = getLiveSession(unlinkedChildId);
    assert.equal(unlinkedLive?.parent_session_id, null);
    assert.equal(unlinkedLive?.relationship_type, null);

    const failedLive = getLiveSession(failedChildId);
    assert.equal(failedLive?.parent_session_id, null);
    assert.equal(failedLive?.relationship_type, null);

    const listed = listBrowsingSessions({ agent: 'antigravity', project: 'demo-children' });
    const listedIds = new Set(listed.data.map(s => s.id));
    assert.equal(listedIds.has(parentId), true);
    assert.equal(listedIds.has(childAId), false, 'child with present parent nests under parent');
    assert.equal(listedIds.has(childBId), false, 'child linked by invoke_subagent nests under parent');
    assert.equal(listedIds.has(orphanChildId), true, 'child with missing parent stays visible');
    assert.equal(listed.data.find(s => s.id === parentId)?.child_count, 2);

    const delegation = getAnalyticsDelegation({ agent: 'antigravity', project: 'demo-children', date_from: '2026-11-27', date_to: '2026-11-27' });
    assert.equal(delegation.totals.sessions.subagent, 3);
    assert.equal(delegation.totals.sessions.started, 3);
  });

  test('attributes Git commits and PRs only with confirming results, and keeps canonical identity across monitor tools, Overview, and warehouse', async () => {
    const repoDir = path.join(tempDir, 'agr-git-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    gitRun(repoDir, ['init', '-b', 'main']);
    gitRun(repoDir, ['remote', 'add', 'origin', 'https://github.com/owner/agr-git-repo.git']);

    const confirmedDate = '2026-11-27T12:00:10Z';
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'confirmed\n');
    gitRun(repoDir, ['add', 'a.txt']);
    gitRun(repoDir, ['commit', '-m', 'feat: confirmed antigravity commit'], {
      GIT_AUTHOR_DATE: confirmedDate,
      GIT_COMMITTER_DATE: confirmedDate,
    });
    const confirmedSha = gitRun(repoDir, ['rev-parse', 'HEAD']);
    const confirmedShort = confirmedSha.slice(0, 7);

    const unconfirmedDate = '2026-11-27T12:10:10Z';
    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'unconfirmed\n');
    gitRun(repoDir, ['add', 'b.txt']);
    gitRun(repoDir, ['commit', '-m', 'feat: unconfirmed no-result commit'], {
      GIT_AUTHOR_DATE: unconfirmedDate,
      GIT_COMMITTER_DATE: unconfirmedDate,
    });
    const unconfirmedSha = gitRun(repoDir, ['rev-parse', 'HEAD']);

    const home = path.join(tempDir, 'agr-git');
    const confirmedSessionId = '60606060-1111-2222-3333-606060606060';
    const unconfirmedSessionId = '61616161-1111-2222-3333-616161616161';

    const tConfirmed = Date.parse('2026-11-27T12:00:00Z') / 1000;
    const callRead: ProtoToolCallSpec = { id: 'call_git_read', name: 'read_file', argsJson: JSON.stringify({ Path: path.join(repoDir, 'a.txt') }) };
    const callEdit: ProtoToolCallSpec = { id: 'call_git_edit', name: 'edit_file', argsJson: JSON.stringify({ Path: path.join(repoDir, 'a.txt'), Target: 'x', Replacement: 'y' }) };
    const callCommit: ProtoToolCallSpec = { id: 'call_git_commit', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'git commit -m "feat: confirmed antigravity commit"' }) };
    const callPr: ProtoToolCallSpec = { id: 'call_git_pr', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'gh pr create --fill' }) };

    writeConversationDb(path.join(home, 'conversations', `${confirmedSessionId}.db`), {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: tConfirmed },
        { idx: 1, type: 15, oneof: 20, tsSecs: tConfirmed + 2, plannerToolCalls: [callRead, callEdit] },
        { idx: 2, type: 132, oneof: 140, tsSecs: tConfirmed + 4, stepToolCall: callRead },
        { idx: 3, type: 132, oneof: 140, tsSecs: tConfirmed + 5, stepToolCall: callEdit },
        { idx: 4, type: 15, oneof: 20, tsSecs: tConfirmed + 8, plannerToolCalls: [callCommit] },
        { idx: 5, type: 132, oneof: 140, tsSecs: tConfirmed + 11, stepToolCall: callCommit },
        { idx: 6, type: 15, oneof: 20, tsSecs: tConfirmed + 15, plannerToolCalls: [callPr] },
        { idx: 7, type: 132, oneof: 140, tsSecs: tConfirmed + 18, stepToolCall: callPr },
      ],
      generations: [
        { model: 'gemini-4-neon', inp: 2000, out: 400, cached: 5000, createdSecs: tConfirmed + 2 },
      ],
    });
    writeTranscript(home, confirmedSessionId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-27T12:00:00Z', content: '<USER_REQUEST>\nCommit and open a PR for secret-prompt-marker\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:00:02Z',
        tool_calls: [
          { name: 'read_file', args: { Path: path.join(repoDir, 'a.txt') } },
          { name: 'edit_file', args: { Path: path.join(repoDir, 'a.txt'), Target: 'x', Replacement: 'y' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T12:00:04Z', content: '1: confirmed' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T12:00:05Z', content: 'Edited a.txt' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:00:08Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'git commit -m "feat: confirmed antigravity commit"' } }],
      },
      {
        step_index: 5,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-27T12:00:11Z',
        content: `Command exited with code 0.\n\nCommand output:\n[main ${confirmedShort}] feat: confirmed antigravity commit\n 1 file changed, 1 insertion(+)`,
      },
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:00:15Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'gh pr create --fill' } }],
      },
      {
        step_index: 7,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-27T12:00:18Z',
        content: 'Command exited with code 0.\n\nCommand output:\nhttps://github.com/owner/agr-git-repo/pull/42\n',
      },
    ]);

    const tUnconfirmed = Date.parse('2026-11-27T12:10:00Z') / 1000;
    const callNoRes: ProtoToolCallSpec = { id: 'call_no_res', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' }) };
    const callErrCommit: ProtoToolCallSpec = { id: 'call_err_commit', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' }) };
    const callRunningCommit: ProtoToolCallSpec = { id: 'call_run_commit', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' }) };
    const callPrNoRes: ProtoToolCallSpec = { id: 'call_pr_no_res', name: 'run_command', argsJson: JSON.stringify({ CommandLine: 'gh pr create --fill' }) };

    writeConversationDb(path.join(home, 'conversations', `${unconfirmedSessionId}.db`), {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: tUnconfirmed },
        { idx: 1, type: 15, oneof: 20, tsSecs: tUnconfirmed + 2, plannerToolCalls: [callNoRes] },
        { idx: 2, type: 15, oneof: 20, tsSecs: tUnconfirmed + 4, plannerToolCalls: [callErrCommit] },
        { idx: 3, type: 132, oneof: 140, status: 7, tsSecs: tUnconfirmed + 5, stepToolCall: callErrCommit },
        { idx: 4, type: 15, oneof: 20, tsSecs: tUnconfirmed + 6, plannerToolCalls: [callRunningCommit] },
        { idx: 5, type: 132, oneof: 140, status: 2, tsSecs: tUnconfirmed + 7, stepToolCall: callRunningCommit },
        { idx: 6, type: 15, oneof: 20, tsSecs: tUnconfirmed + 8, plannerToolCalls: [callPrNoRes] },
      ],
    });
    writeTranscript(home, unconfirmedSessionId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-27T12:10:00Z', content: '<USER_REQUEST>\nAttempt commits without confirming results\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:10:02Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:10:04Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' } }],
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'ERROR',
        error: 'hook rejected commit',
        created_at: '2026-11-27T12:10:05Z',
        content: 'Command exited with code 1.\npre-commit hook failed',
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:10:06Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'git commit -m "feat: unconfirmed no-result commit"' } }],
      },
      {
        step_index: 5,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-27T12:10:07Z',
        content: 'Tool is running as a background task with task id: task-5',
      },
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-27T12:10:08Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'gh pr create --fill' } }],
      },
    ]);

    writeSummaryDb(home, [
      { conversation_id: confirmedSessionId, title: 'Confirmed Git work', workspace_uris: JSON.stringify([`file://${repoDir}`]) },
      { conversation_id: unconfirmedSessionId, title: 'Unconfirmed Git work', workspace_uris: JSON.stringify([`file://${repoDir}`]) },
    ]);

    const db = getDb();
    assert.equal(syncAllAntigravityFiles(db, home).parsed, 2);

    const gitReport = await syncGitActivity(db, { now: new Date('2026-11-27T13:00:00Z') });
    assert.ok(gitReport.repos >= 1);
    assert.ok(gitReport.commits_seen >= 2);

    const confirmedGit = getSessionGitActivity(confirmedSessionId);
    assert.deepEqual(confirmedGit.commits.map(c => c.sha), [confirmedSha]);
    assert.deepEqual(confirmedGit.pull_requests.map(pr => [pr.repo, pr.number]), [['owner/agr-git-repo', 42]]);

    const unconfirmedGit = getSessionGitActivity(unconfirmedSessionId);
    assert.deepEqual(unconfirmedGit.commits, [], 'Git command without confirming result must not attribute commit');
    assert.deepEqual(unconfirmedGit.pull_requests, [], 'PR command without confirming result must not attribute PR');

    const gitAnalytics = getAnalyticsGitActivity({ project: 'agr-git-repo', date_from: '2026-11-27', date_to: '2026-11-27' });
    assert.equal(gitAnalytics.coverage.commits, 2);
    assert.equal(gitAnalytics.coverage.proven, 1);
    const agrAgent = gitAnalytics.agents.find(a => a.agent === 'antigravity');
    assert.deepEqual(agrAgent, { agent: 'antigravity', commits: 1, sessions: 1, prs_opened: 1, prs_merged: 0 });
    assert.ok(unconfirmedSha.length === 40);

    const monitorTools = getMonitorToolStats({ agent: 'antigravity', project: 'agr-git-repo' });
    const toolCounts = Object.fromEntries(monitorTools.map(t => [t.tool_name, t.total_calls]));
    assert.equal(toolCounts.read_file, 1);
    assert.equal(toolCounts.edit_file, 1);
    assert.ok((toolCounts.run_command ?? 0) >= 2);
    const runStat = monitorTools.find(t => t.tool_name === 'run_command');
    assert.ok(runStat && runStat.error_count >= 1);

    const timing = await getSessionToolTiming(confirmedSessionId, { limit: 25, offset: 0 });
    assert.ok(timing);
    assert.equal(timing.session_id, confirmedSessionId);
    assert.equal(timing.agent, 'antigravity');
    assert.equal(timing.source_selection, 'monitor_index');
    assert.equal(timing.coverage.status, 'available');
    assert.equal(timing.total_calls, 4);
    assert.deepEqual(
      timing.calls.map(c => [c.tool, c.elapsed_ms]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1])),
      [['edit_file', 3000], ['read_file', 2000], ['run_command', 3000], ['run_command', 3000]],
    );

    const overviewTools = getAnalyticsTools({ agent: 'antigravity', project: 'agr-git-repo' });
    assert.ok(overviewTools.some(t => t.tool_name === 'run_command' && t.category === 'Bash'));
    assert.ok(overviewTools.some(t => t.tool_name === 'read_file' && t.category === 'Read'));
    assert.ok(overviewTools.some(t => t.tool_name === 'edit_file' && t.category === 'Edit'));

    const overviewSummary = getAnalyticsSummary({ agent: 'antigravity', project: 'agr-git-repo' });
    assert.equal(overviewSummary.total_sessions, 2);

    const summaries = listWarehouseSessionTraceSummaries({ date_from: '2026-11-27', date_to: '2026-11-27' });
    const agrSummary = summaries.find(s => s.session_id === confirmedSessionId);
    assert.ok(agrSummary);
    assert.equal(agrSummary.agent_type, 'antigravity');
    assert.equal(agrSummary.project, 'agr-git-repo');
    assert.equal(agrSummary.tokens_in, 2000);
    assert.equal(agrSummary.tokens_out, 400);
    assert.equal(agrSummary.cache_read_tokens, 5000);
    const runRow = mapSummaryToRunRow(agrSummary, 'test-account', 'run-slice4');
    assertContentFree(runRow);
    assert.equal(runRow.session_id, confirmedSessionId);
    assert.equal(JSON.stringify(runRow).includes('secret-prompt-marker'), false);
  });

  test('rejects non-zero shell exit skill reads, scopes compound shell reads to read segments, and supports ./ relative skill paths', async () => {
    const home = path.join(tempDir, 'agr-shell-skill-edges');
    const sessionId = '70707070-1111-2222-3333-707070707070';
    const repoCwd = path.join(tempDir, 'shell-skill-repo');
    fs.mkdirSync(repoCwd, { recursive: true });

    const t0 = Date.parse('2026-11-28T10:00:00Z') / 1000;
    const callNonZero: ProtoToolCallSpec = {
      id: 'call_nonzero_shell',
      name: 'run_command',
      argsJson: JSON.stringify({ CommandLine: 'cat /Users/example/.gemini/config/skills/nonzero-shell-skill/SKILL.md' }),
    };
    const callCompound: ProtoToolCallSpec = {
      id: 'call_compound_shell',
      name: 'run_command',
      argsJson: JSON.stringify({
        CommandLine: 'cat /Users/example/.agents/skills/compound-read/SKILL.md ; echo /Users/example/.agents/skills/compound-mention/SKILL.md',
      }),
    };
    const callDotRelative: ProtoToolCallSpec = {
      id: 'call_dot_relative_shell',
      name: 'run_command',
      argsJson: JSON.stringify({ CommandLine: 'cat ./.agents/skills/dot-relative-skill/SKILL.md' }),
    };

    writeConversationDb(path.join(home, 'conversations', `${sessionId}.db`), {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: t0 },
        { idx: 1, type: 15, oneof: 20, tsSecs: t0 + 1, plannerToolCalls: [callNonZero, callCompound, callDotRelative] },
        { idx: 2, type: 132, oneof: 140, tsSecs: t0 + 2, stepToolCall: callNonZero },
        { idx: 3, type: 132, oneof: 140, tsSecs: t0 + 3, stepToolCall: callCompound },
        { idx: 4, type: 132, oneof: 140, tsSecs: t0 + 4, stepToolCall: callDotRelative },
      ],
      generations: [
        { model: 'gemini-4-neon', inp: 900, out: 120, cached: 1000, createdSecs: t0 + 1 },
      ],
    });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: 'Shell skill edge cases',
      workspace_uris: JSON.stringify([`file://${repoCwd}`]),
    }]);
    writeTranscript(home, sessionId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T10:00:00Z', content: 'Check shell skill reads' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-28T10:00:01Z',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'cat /Users/example/.gemini/config/skills/nonzero-shell-skill/SKILL.md' } },
          {
            name: 'run_command',
            args: { CommandLine: 'cat /Users/example/.agents/skills/compound-read/SKILL.md ; echo /Users/example/.agents/skills/compound-mention/SKILL.md' },
          },
          { name: 'run_command', args: { CommandLine: 'cat ./.agents/skills/dot-relative-skill/SKILL.md' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-28T10:00:02Z',
        content: 'Command exited with code 1.\ncat: /Users/example/.gemini/config/skills/nonzero-shell-skill/SKILL.md: No such file or directory',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-28T10:00:03Z',
        content: 'Command exited with code 0.\n# compound-read\n/Users/example/.agents/skills/compound-mention/SKILL.md',
      },
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-28T10:00:04Z',
        content: 'Command exited with code 0.\n# dot-relative-skill',
      },
    ]);

    const db = getDb();
    assert.equal(syncAllAntigravityFiles(db, home).parsed, 1);

    const nonZeroItem = db.prepare(`
      SELECT status, payload_json FROM session_items
      WHERE session_id = ? AND kind = 'tool_result' AND source_item_id = ?
    `).get(sessionId, 'call_nonzero_shell') as { status: string; payload_json: string } | undefined;
    assert.ok(nonZeroItem);
    assert.equal(nonZeroItem.status, 'error');
    const nonZeroPayload = JSON.parse(nonZeroItem.payload_json) as { is_error?: boolean };
    assert.equal(nonZeroPayload.is_error, true);

    const ctx = getSessionSkillContext(db, sessionId);
    assert.ok(ctx);
    assert.deepEqual(
      ctx.observations.filter(o => o.kind === 'consultation').map(o => o.skillName),
      ['compound-read', 'dot-relative-skill'],
    );

    const daily = getAnalyticsSkillsDaily({ agent: 'antigravity', date_from: '2026-11-28', date_to: '2026-11-28' });
    assert.equal(daily.length, 1);
    const bySkill = Object.fromEntries(daily[0].skills.map(s => [s.skill_name, s.count]));
    assert.deepEqual(bySkill, {
      'compound-read': 1,
      'dot-relative-skill': 1,
    });
    assert.equal(bySkill['nonzero-shell-skill'], undefined);
    assert.equal(bySkill['compound-mention'], undefined);

    const consultations = getAnalyticsSkillConsultations({
      agent: 'antigravity',
      date_from: '2026-11-28',
      date_to: '2026-11-28',
    });
    const agrHarness = consultations.byHarness.find(h => h.harness === 'antigravity');
    assert.ok(agrHarness);
    assert.deepEqual(
      agrHarness.skills.map(s => s.name).sort(),
      ['compound-read', 'dot-relative-skill'],
    );

    const ctxRes = await fetch(`${baseUrl}/api/v2/sessions/${sessionId}/skill-context`);
    assert.equal(ctxRes.status, 200);
    const ctxJson = await ctxRes.json() as { observations: Array<{ kind: string; skillName?: string }> };
    assert.deepEqual(
      ctxJson.observations.filter(o => o.kind === 'consultation').map(o => o.skillName),
      ['compound-read', 'dot-relative-skill'],
    );
  });

  test('tool timing leaves RUNNING Antigravity receipts open until a terminal receipt arrives', async () => {
    const home = path.join(tempDir, 'agr-running-timing');
    const sessionId = '80808080-1111-2222-3333-808080808080';
    const repoCwd = path.join(tempDir, 'running-timing-repo');
    fs.mkdirSync(repoCwd, { recursive: true });

    const t0 = Date.parse('2026-11-28T11:00:00Z') / 1000;
    const callRead: ProtoToolCallSpec = {
      id: 'call_done_read',
      name: 'read_file',
      argsJson: JSON.stringify({ Path: path.join(repoCwd, 'README.md') }),
    };
    const callRun: ProtoToolCallSpec = {
      id: 'call_running_cmd',
      name: 'run_command',
      argsJson: JSON.stringify({ CommandLine: 'pnpm test' }),
    };

    const dbFile = path.join(home, 'conversations', `${sessionId}.db`);
    writeConversationDb(dbFile, {
      steps: [
        { idx: 0, type: 14, oneof: 19, tsSecs: t0 },
        { idx: 1, type: 15, oneof: 20, tsSecs: t0 + 1, plannerToolCalls: [callRead, callRun] },
        { idx: 2, type: 132, oneof: 140, status: 3, tsSecs: t0 + 3, stepToolCall: callRead },
        { idx: 3, type: 132, oneof: 140, status: 6, tsSecs: t0 + 4, stepToolCall: callRun },
      ],
      generations: [
        { model: 'gemini-4-neon', inp: 500, out: 80, cached: 500, createdSecs: t0 + 1 },
      ],
    });
    writeSummaryDb(home, [{
      conversation_id: sessionId,
      title: 'Running tool timing test',
      workspace_uris: JSON.stringify([`file://${repoCwd}`]),
    }]);
    writeTranscript(home, sessionId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T11:00:00Z', content: 'Run tests' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-28T11:00:01Z',
        tool_calls: [
          { name: 'read_file', args: { Path: path.join(repoCwd, 'README.md') } },
          { name: 'run_command', args: { CommandLine: 'pnpm test' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-28T11:00:03Z',
        content: '# README',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-28T11:00:04Z',
        content: 'Tool is running as a background task with task id: task-1',
      },
    ]);

    const db = getDb();
    assert.equal(syncAllAntigravityFiles(db, home).parsed, 1);

    const openTiming = await getSessionToolTiming(sessionId, { limit: 25, offset: 0 });
    assert.ok(openTiming);
    assert.equal(openTiming.coverage.open_calls, 1);
    assert.equal(openTiming.coverage.unmatched_returns, 0);
    assert.equal(openTiming.total_calls, 1);
    assert.deepEqual(
      openTiming.calls.map(c => [c.tool, c.elapsed_ms]),
      [['read_file', 2000]],
    );

    writeTranscript(home, sessionId, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T11:00:00Z', content: 'Run tests' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-28T11:00:01Z',
        tool_calls: [
          { name: 'read_file', args: { Path: path.join(repoCwd, 'README.md') } },
          { name: 'run_command', args: { CommandLine: 'pnpm test' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-28T11:00:03Z',
        content: '# README',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-28T11:00:04Z',
        content: 'Tool is running as a background task with task id: task-1',
      },
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        tool_call_id: 'call_running_cmd',
        created_at: '2026-11-28T11:00:13Z',
        content: 'Command exited with code 0.\nAll tests passed.',
      },
    ]);

    const closedTiming = await getSessionToolTiming(sessionId, { limit: 25, offset: 0 });
    assert.ok(closedTiming);
    assert.equal(closedTiming.coverage.open_calls, 0);
    assert.equal(closedTiming.coverage.unmatched_returns, 0);
    assert.equal(closedTiming.total_calls, 2);
    assert.deepEqual(
      closedTiming.calls.map(c => [c.tool, c.elapsed_ms]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [['read_file', 2000], ['run_command', 12000]],
    );
  });
});
