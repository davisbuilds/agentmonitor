import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  CLAUDE_RECORD_TYPES,
  CODEX_RECORD_TYPES,
  claudeRecordKind,
  codexRecordKind,
  emptyRecordTypeTally,
  tallyRecordTypes,
} from '../src/parser/record-types.js';

const jsonl = (lines: unknown[]) => lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');

test('a new record type is reported as unknown, apart from read and known-unused ones', () => {
  const tally = tallyRecordTypes(jsonl([
    { type: 'assistant' }, { type: 'assistant' }, { type: 'pr-link' }, { type: 'brand-new-record' }, '{not json', { no: 'type' },
  ]), claudeRecordKind, CLAUDE_RECORD_TYPES, emptyRecordTypeTally());
  assert.deepEqual(tally, {
    lines: 6, untyped: 2, read: { assistant: 2 }, known_unused: { 'pr-link': 1 }, unknown: { 'brand-new-record': 1 },
  });
});

test('Codex lines are kinded by payload type, and an older role-only response item is a message', () => {
  const tally = tallyRecordTypes(jsonl([
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning_v2' } },
    { type: 'response_item', payload: { role: 'user', content: [] } },
    { type: 'response_item', payload: { type: 'reasoning' } },
    { type: 'session_meta', payload: {} },
  ]), codexRecordKind, CODEX_RECORD_TYPES, emptyRecordTypeTally());
  assert.deepEqual(tally.read, { 'event_msg/token_count': 1, 'response_item/message': 1, session_meta: 1 });
  assert.deepEqual(tally.known_unused, { 'response_item/reasoning': 1 });
  assert.deepEqual(tally.unknown, { 'event_msg/agent_reasoning_v2': 1 });
});

test('no type is both read and known-unused', () => {
  for (const catalog of [CLAUDE_RECORD_TYPES, CODEX_RECORD_TYPES]) {
    assert.deepEqual(Object.keys(catalog.read).filter(type => Object.hasOwn(catalog.knownUnused, type)), []);
  }
});

/** The record types a source file compares a line's `type` against. */
function branchedTypes(file: string, patterns: RegExp[]): string[] {
  const source = fs.readFileSync(file, 'utf8');
  return patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match.slice(1).filter(Boolean).join('/')));
}

test('every record type a parser branches on is listed as read', () => {
  const claude = [
    ...branchedTypes('src/parser/claude-code.ts', [/lineType [!=]== '([a-z-]+)'/g]),
    ...branchedTypes('src/import/claude-code.ts', [/\bline\.type [!=]== '([a-z_-]+)'/g]),
  ];
  const codexPatterns = [
    /line\.type [!=]== '(?!event_msg'|response_item')([a-z_]+)'/g,
    /line\.type === '(event_msg)' && (?:entry\.)?line\.payload\?\.type === '([a-z_]+)'/g,
  ];
  const codex = [
    ...branchedTypes('src/parser/codex-sessions.ts', codexPatterns),
    ...branchedTypes('src/import/codex.ts', codexPatterns),
  ];
  assert.ok(claude.length >= 4 && codex.length >= 6, 'the patterns must find the parsers\' branches');
  assert.deepEqual([...new Set(claude)].filter(type => !Object.hasOwn(CLAUDE_RECORD_TYPES.read, type)), []);
  assert.deepEqual([...new Set(codex)].filter(type => !Object.hasOwn(CODEX_RECORD_TYPES.read, type)), []);
});
