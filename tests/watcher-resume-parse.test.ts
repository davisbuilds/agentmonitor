import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { closeDb as closeDbFn, getDb as getDbFn } from '../src/db/connection.js';
import type * as WatcherIndex from '../src/watcher/index.js';

let tempDir = '';
let transcripts = '';
let getDb: typeof getDbFn;
let closeDb: typeof closeDbFn;
let watcher: typeof WatcherIndex;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-resume-parse-'));
  transcripts = path.join(tempDir, 'transcripts');
  fs.mkdirSync(transcripts);
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  ({ getDb, closeDb } = await import('../src/db/connection.js'));
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  watcher = await import('../src/watcher/index.js');
  assert.equal(getDb().name, path.join(tempDir, 'test.db'));
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

type Agent = 'claude' | 'codex';

const catalog = `<skills_instructions>
<skills>
<skill><name>test-strategy</name><description>Test behavior.</description><location>/skills/test-strategy/SKILL.md</location><scope>global</scope></skill>
</skills>
</skills_instructions>`;

function at(second: number): string {
  return `2026-07-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}

// Every kind of line the Claude parser carries state across: a meta prompt
// that is not the first message, usage and model, a malformed record, a skill
// consultation, a compaction, a subagent spawn, a sidechain turn and a new cwd.
const CLAUDE_LINES = [
  JSON.stringify({ type: 'user', isMeta: true, cwd: '/work/alpha', entrypoint: 'cli', timestamp: at(0), message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
  JSON.stringify({ type: 'user', cwd: '/work/alpha', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'please inspect the repo' }] } }),
  JSON.stringify({ type: 'assistant', cwd: '/work/alpha', timestamp: at(2), message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }] } }),
  JSON.stringify({ type: 'user', cwd: '/work/alpha', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'README.md' }] } }),
  '{"type": "user", "message": {"role": "user", "content": "trunc',
  JSON.stringify({ type: 'assistant', cwd: '/work/alpha', timestamp: at(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'test-strategy' } }] } }),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', cwd: '/work/alpha', timestamp: at(6) }),
  JSON.stringify({ type: 'assistant', cwd: '/work/alpha', timestamp: at(7), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'look', session_id: 'agent-child1' } }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/alpha', timestamp: at(8), message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 3 }, content: [{ type: 'text', text: 'sidechain reply' }] } }),
  JSON.stringify({ type: 'user', cwd: '/work/beta', timestamp: at(9), message: { role: 'user', content: [{ type: 'text', text: 'now the other repo' }] } }),
  JSON.stringify({ type: 'assistant', cwd: '/work/beta', timestamp: at(10), message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 12, cache_read_input_tokens: 4000 }, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'done' }] } }),
];

// A catalog presented before the first turn_context and token count, so its
// recorded model and window come from later lines until both have appeared.
const CODEX_LINES = [
  JSON.stringify({ type: 'session_meta', timestamp: at(0), payload: { id: 'c0dex000-0000-4000-8000-000000000000', cwd: '/work/alpha', originator: 'codex_cli_rs', cli_version: '0.150.0', source: 'cli' } }),
  JSON.stringify({ type: 'response_item', timestamp: at(1), payload: { role: 'developer', content: [{ type: 'input_text', text: catalog }] } }),
  JSON.stringify({ type: 'turn_context', timestamp: at(2), payload: { cwd: '/work/alpha', model: 'gpt-5.6-terra' } }),
  JSON.stringify({ type: 'event_msg', timestamp: at(3), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000 }, model_context_window: 258400 } } }),
  JSON.stringify({ type: 'response_item', timestamp: at(4), payload: { role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] } }),
  JSON.stringify({ type: 'response_item', timestamp: at(5), payload: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat /skills/test-strategy/SKILL.md' }) } }),
  JSON.stringify({ type: 'world_state', timestamp: at(6), payload: { state: { agents_md: { directory: '/work/alpha', text: 'instructions' } } } }),
  JSON.stringify({ type: 'compacted', timestamp: at(7), payload: { replacement_history: [{ type: 'response_item', payload: { role: 'developer', content: [{ type: 'input_text', text: catalog.replace('Test behavior.', 'Test carefully.') }] } }] } }),
  JSON.stringify({ type: 'response_item', timestamp: at(8), payload: { role: 'assistant', content: [{ type: 'output_text', text: 'tests pass' }] } }),
  JSON.stringify({ type: 'turn_context', timestamp: at(9), payload: { cwd: '/work/beta', model: 'gpt-5.6-terra-mini' } }),
  JSON.stringify({ type: 'event_msg', timestamp: at(10), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000 }, model_context_window: 128000 } } }),
  JSON.stringify({ type: 'response_item', timestamp: at(11), payload: { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] } }),
];

// A spawned subagent whose rollout opens with a copy of its parent's turn. The
// copy is dropped only once the child's own first turn has been written.
const SUBAGENT_LINES = [
  JSON.stringify({ type: 'session_meta', timestamp: at(0), payload: { id: '01a0a82a-8672-7012-bbc6-467629b03bbe', cwd: '/work/alpha', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } } } }),
  JSON.stringify({ type: 'turn_context', timestamp: at(0), payload: { turn_id: '01a0a000-0000-7000-8000-000000000000', model: 'gpt-5.6-terra' } }),
  JSON.stringify({ type: 'response_item', timestamp: at(0), payload: { role: 'user', content: [{ type: 'input_text', text: 'parent request' }] } }),
  JSON.stringify({ type: 'event_msg', timestamp: at(0), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500 } } } }),
  JSON.stringify({ type: 'turn_context', timestamp: at(1), payload: { turn_id: '01a0a82b-0000-7000-8000-000000000000', model: 'gpt-5.6-terra' } }),
  JSON.stringify({ type: 'response_item', timestamp: at(2), payload: { role: 'user', content: [{ type: 'input_text', text: 'child task' }] } }),
  JSON.stringify({ type: 'response_item', timestamp: at(3), payload: { role: 'assistant', content: [{ type: 'output_text', text: 'child done' }] } }),
];

function sync(agent: Agent, file: string, options: { force?: boolean } = {}): WatcherIndex.SyncSessionOutcome {
  return agent === 'codex'
    ? watcher.syncCodexSessionFileDetailed(getDb(), file, options)
    : watcher.syncSessionFileDetailed(getDb(), file, options);
}

function transcript(name: string, lines: string[]): string {
  const file = path.join(transcripts, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(line => line + '\n').join(''));
  return file;
}

function append(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map(line => line + '\n').join(''));
}

/** Everything a sync stores for a session, minus its id, path and row ids. */
function snapshot(file: string): unknown {
  const db = getDb();
  const sessionId = path.basename(file, '.jsonl');
  const all = (sql: string) => db.prepare(sql).all(sessionId);
  return {
    session: db.prepare(`
      SELECT project, agent, first_message, started_at, ended_at, message_count, user_message_count,
        parent_session_id, relationship_type, live_status, last_item_at, integration_mode, fidelity,
        capabilities_json, file_size, file_hash, context_used_tokens, context_window_tokens,
        project_identity, skill_context_capabilities_json
      FROM browsing_sessions WHERE id = ?
    `).get(sessionId),
    watched: db.prepare('SELECT file_hash, status FROM watched_files WHERE file_path = ?').get(file),
    messages: all(`
      SELECT ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length
      FROM messages WHERE session_id = ? ORDER BY ordinal
    `),
    toolCalls: all(`
      SELECT m.ordinal, tc.tool_name, tc.category, tc.tool_use_id, tc.input_json, tc.subagent_session_id
      FROM tool_calls tc JOIN messages m ON m.id = tc.message_id
      WHERE tc.session_id = ? ORDER BY m.ordinal, tc.id
    `),
    observations: all(`
      SELECT ordinal, kind, source, observed_at, skill_name, command_fingerprint, project_identity,
        reason, metadata_json
      FROM session_context_observations WHERE session_id = ?
      ORDER BY ordinal, kind, source, skill_name, metadata_json
    `),
    catalogEntries: all(`
      SELECT o.ordinal, e.ordinal AS entry, e.skill_name, e.description, e.description_fingerprint,
        e.source_location, e.scope
      FROM session_catalog_observation_entries e
      JOIN session_context_observations o ON o.id = e.observation_id
      WHERE o.session_id = ? ORDER BY o.ordinal, e.ordinal
    `),
    turns: all(`
      SELECT agent_type, source_turn_id, status, title, started_at, ended_at
      FROM session_turns WHERE session_id = ? ORDER BY id
    `),
    items: all(`
      SELECT t.source_turn_id, i.ordinal, i.source_item_id, i.kind, i.status, i.payload_json, i.created_at
      FROM session_items i JOIN session_turns t ON t.id = i.turn_id
      WHERE i.session_id = ? ORDER BY i.id
    `),
  };
}

/** What a single sync of the whole transcript stores. */
function reference(agent: Agent, name: string, lines: string[]): unknown {
  const file = transcript(`ref-${name}`, lines);
  assert.equal(sync(agent, file).result, 'parsed');
  return snapshot(file);
}

/** Sync the first `split` lines, append the rest, sync again; return how the second parse ran. */
function splitSync(agent: Agent, name: string, lines: string[], split: number): { parse: string; stored: unknown } {
  const file = transcript(`inc-${name}-${split}`, lines.slice(0, split));
  sync(agent, file);
  append(file, lines.slice(split));
  const outcome = sync(agent, file);
  assert.equal(outcome.result, 'parsed');
  return { parse: outcome.parse ?? 'none', stored: snapshot(file) };
}

const FIXTURES: Array<{ agent: Agent; name: string; lines: string[]; parses: string[] }> = [
  // Split 1 holds only a meta prompt, which is a message, so it is resumable.
  { agent: 'claude', name: 'claude', lines: CLAUDE_LINES, parses: Array(CLAUDE_LINES.length - 1).fill('resumed') },
  // Split 1 has no message to store. Splits 2 and 3 recorded the catalog before
  // the model and the window had appeared.
  { agent: 'codex', name: 'codex', lines: CODEX_LINES, parses: ['full', 'full', 'full', ...Array(CODEX_LINES.length - 4).fill('resumed')] },
  // Splits 1 to 4 end before the child's own first turn; split 5 ends at it, so
  // the copy is dropped and no message is left to store.
  { agent: 'codex', name: 'subagent', lines: SUBAGENT_LINES, parses: ['full', 'full', 'full', 'full', 'full', 'resumed'] },
];

describe('watcher parse resumes after the bytes it already parsed', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}: every split stores what one whole parse stores`, () => {
      const expected = reference(fixture.agent, fixture.name, fixture.lines);
      const parses: string[] = [];
      for (let split = 1; split < fixture.lines.length; split++) {
        const { parse, stored } = splitSync(fixture.agent, fixture.name, fixture.lines, split);
        assert.deepEqual(stored, expected, `split after line ${split}`);
        parses.push(parse);
      }
      assert.deepEqual(parses, fixture.parses);
    });

    test(`${fixture.name}: appending one line at a time stores what one whole parse stores`, () => {
      const expected = reference(fixture.agent, `${fixture.name}-lines`, fixture.lines);
      const file = transcript(`inc-${fixture.name}-lines`, fixture.lines.slice(0, 1));
      sync(fixture.agent, file);
      let resumed = 0;
      for (const line of fixture.lines.slice(1)) {
        append(file, [line]);
        if (sync(fixture.agent, file).parse === 'resumed') resumed++;
      }
      assert.deepEqual(snapshot(file), expected);
      assert.equal(resumed, fixture.parses.filter(parse => parse === 'resumed').length);
    });
  }
});

describe('watcher parse falls back to the whole file', () => {
  const base = CLAUDE_LINES.slice(0, 4);
  const rest = CLAUDE_LINES.slice(4);

  test('when an earlier line changed, even at the same length', () => {
    const file = transcript('fallback-rewrite', base);
    sync('claude', file);
    const rewritten = [base[0], base[1].replace('inspect', 'inspeKt'), ...base.slice(2), ...rest];
    fs.writeFileSync(file, rewritten.map(line => line + '\n').join(''));

    assert.equal(sync('claude', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('claude', 'fallback-rewrite', rewritten));
  });

  test('when the file was truncated', () => {
    const file = transcript('fallback-truncate', [...base, ...rest]);
    sync('claude', file);
    fs.writeFileSync(file, base.map(line => line + '\n').join(''));

    assert.equal(sync('claude', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('claude', 'fallback-truncate', base));
  });

  test('when the stored rows no longer match what the last parse wrote', () => {
    const file = transcript('fallback-store', base);
    sync('claude', file);
    getDb().prepare('DELETE FROM messages WHERE session_id = ? AND ordinal = 1').run('fallback-store');
    append(file, rest);

    assert.equal(sync('claude', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('claude', 'fallback-store', [...base, ...rest]));
  });

  test('after a sync that ended inside a line', () => {
    const file = transcript('fallback-partial', base);
    sync('claude', file);
    const [next, ...later] = rest.slice(1);
    fs.appendFileSync(file, next.slice(0, 20));
    sync('claude', file);
    fs.appendFileSync(file, next.slice(20) + '\n' + later.map(line => line + '\n').join(''));

    assert.equal(sync('claude', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('claude', 'fallback-partial', [...base, ...rest.slice(1)]));
  });

  test('when forced, or after the checkpoints are cleared', () => {
    const file = transcript('fallback-force', base);
    sync('claude', file);
    append(file, rest.slice(0, 2));
    assert.equal(sync('claude', file, { force: true }).parse, 'full');
    append(file, rest.slice(2, 4));
    assert.equal(sync('claude', file).parse, 'resumed');
    watcher.clearParseCheckpoints();
    append(file, rest.slice(4));
    assert.equal(sync('claude', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('claude', 'fallback-force', [...base, ...rest]));
  });

  test('while a Codex rollout has not yet written its session_meta line', () => {
    // The session line names the start time and project, whatever its position.
    const lines = [CODEX_LINES[4], CODEX_LINES[0], CODEX_LINES[11]];
    const file = transcript('fallback-no-meta', lines.slice(0, 1));
    sync('codex', file);
    append(file, lines.slice(1));

    assert.equal(sync('codex', file).parse, 'full');
    assert.deepEqual(snapshot(file), reference('codex', 'fallback-no-meta', lines));
  });

  test('an unchanged file is still skipped', () => {
    const file = transcript('fallback-unchanged', base);
    sync('claude', file);
    assert.equal(sync('claude', file).result, 'skipped');
    append(file, rest);
    assert.equal(sync('claude', file).parse, 'resumed');
  });
});
