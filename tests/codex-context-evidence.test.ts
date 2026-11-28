import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexSessionMessages } from '../src/parser/codex-sessions.js';
import { projectIdentityFromCwd } from '../src/skills/context-observations.js';

type RecordPayload = Record<string, unknown>;

function record(type: string, second: number, payload: RecordPayload): string {
  return JSON.stringify({
    type,
    timestamp: '2026-07-01T00:00:' + String(second).padStart(2, '0') + 'Z',
    payload,
  });
}

const header = record('session_meta', 0, { cwd: '/work/start', cli_version: '0.170.0' });

function message(text: string, role = 'developer'): RecordPayload {
  return { role, type: 'message', content: [{ type: 'input_text', text }] };
}

function scope(second: number, cwd = '/work/current'): string {
  return record('turn_context', second, { cwd, model: 'current-model' });
}

function block(heading: string, entries: string[], roots: string[] = []): string {
  const update = heading.endsWith('update');
  return [
    '<skills_instructions>', '## ' + heading,
    ...(roots.length ? ['### Skill roots', ...(update ? ['These mappings replace earlier mappings for the same aliases.'] : []), ...roots] : []),
    update ? '### Added or updated skills:' : '### Available skills',
    ...entries, '</skills_instructions>',
  ].join('\n');
}

const backtick = String.fromCharCode(96);
function root(alias: string, directory: string): string {
  return '- ' + backtick + alias + backtick + ' = ' + backtick + directory + backtick;
}

const host = block('Host skills', [
  '- duplicate: First. (file: r0/skill/SKILL.md)',
  '- duplicate: Second. (file: /other/skill/SKILL.md)',
], [root('r0', '/original')]);
const cloud = block('Cloud skills', ['- remote: Cloud skill. (cloud package: skill://example/cloud)']);
const delta = block('Host skills update', [
  '- renamed: Updated. (file: /original/skill/SKILL.md)',
  '- extra: New. (file: r0/other/SKILL.md)',
], [root('r0', '/new')]);

function parse(...lines: string[]) {
  const parsed = parseCodexSessionMessages([header, ...lines].join('\n'), 'codex-context').skillContext!;
  return {
    ...parsed,
    catalog: parsed.observations.filter(row => row.kind === 'catalog_presentation'),
    sources: (parsed.capabilities as { codexCatalogSources?: unknown[] }).codexCatalogSources,
  };
}

test('Codex does not infer catalog presentation from a user quotation or explicitly non-skill developer content', () => {
  const nonSkill = {
    ...message(host),
    internal_chat_message_metadata_passthrough: {
      content_item_metadata: [{ provenance: { type: 'agents_md' } }],
    },
  };
  const parsed = parse(record('response_item', 1, message(host, 'user')), record('response_item', 2, nonSkill), scope(3));
  assert.equal(parsed.catalog.length, 0);
});

test('Codex keeps emitted delta entries separate from effective source membership', () => {
  const parsed = parse(
    record('response_item', 1, message(host)), record('response_item', 1, message(cloud)), scope(2),
    record('response_item', 3, message(delta)), scope(4, '/work/other'),
  );
  assert.deepEqual(parsed.catalog.map(row => [row.metadata?.['catalogKind'], row.catalogEntries?.map(entry => entry.name)]), [
    ['full', ['duplicate', 'duplicate']], ['full', ['remote']], ['delta', ['renamed', 'extra']],
  ]);
  assert.deepEqual(parsed.catalog.map(row => row.projectIdentity), [
    projectIdentityFromCwd('/work/current'), projectIdentityFromCwd('/work/current'), projectIdentityFromCwd('/work/other'),
  ]);
  assert.deepEqual(parsed.sources?.map(source => {
    const state = source as { source: string; entries: { name: string; sourceLocation: string }[] };
    return [state.source, state.entries.map(entry => [entry.name, entry.sourceLocation])];
  }), [
    ['host', [['renamed', '/original/skill/SKILL.md'], ['duplicate', '/other/skill/SKILL.md'], ['extra', '/new/other/SKILL.md']]],
    ['cloud', [['remote', 'skill://example/cloud']]],
  ]);
});

test('Codex compaction does not emit another catalog or consultation from a retained copy', () => {
  const consultation = { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat /skills/diagnose/SKILL.md' }) };
  const parsed = parse(
    record('response_item', 1, message(host)), scope(2), record('response_item', 3, consultation),
    record('compacted', 4, { replacement_history: [message(host), consultation] }), scope(5),
  );
  assert.equal(parsed.catalog.length, 1);
  assert.equal(parsed.observations.filter(row => row.kind === 'consultation').length, 1);
  assert.equal(parsed.catalog[0]?.timestamp, '2026-07-01T00:00:01Z');
});

test('Codex records text-only AGENTS presence without retaining content or claiming a path', () => {
  const parsed = parse(record('world_state', 1, { full: true, state: { agents_md: { text: 'private sentinel' } } }));
  const loads = parsed.observations.filter(row => row.kind === 'instruction_load');
  assert.equal(loads.length, 1);
  assert.equal(loads[0]?.metadata?.['file_path'], null);
  assert.equal(JSON.stringify(parsed).includes('private sentinel'), false);
});

test('Codex rollback invalidates update bases until another full same-source catalog', () => {
  const parsed = parse(
    record('response_item', 1, message(host)), scope(2),
    record('event_msg', 3, { type: 'thread_rolled_back', num_turns: 1 }),
    record('response_item', 4, message(delta)), scope(5),
  );
  assert.equal(parsed.catalog.length, 1);
  assert.deepEqual((parsed.sources as { status: string }[] | undefined)?.map(source => source.status), ['unknown']);
});

test('Codex cannot borrow a later unrelated turn across a user boundary', () => {
  const parsed = parse(
    record('response_item', 1, message(host)), scope(2),
    record('response_item', 3, message(delta)),
    record('response_item', 4, message('new request', 'user')), scope(5, '/unrelated'),
  );
  assert.equal(parsed.catalog.length, 1);
  assert.deepEqual((parsed.sources as { status: string }[] | undefined)?.map(source => source.status), ['unknown']);
});

test('Codex recognizes a fresh typed compacted catalog only with its complete checkpoint', () => {
  const updated = block('Host skills', ['- recovery: Recovery. (file: /new/recovered/SKILL.md)']);
  const typed = {
    ...message(updated),
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['host_skills.instructions'],
      content_item_metadata: [{ provenance: { type: 'skills' } }],
    },
  };
  const checkpoint = record('world_state', 4, {
    full: true,
    state: { host_skills: { includeInstructions: true, body: updated.split('\n').slice(1, -1).join('\n') } },
  });
  const replayed = parse(
    record('response_item', 1, message(host)), scope(2),
    record('compacted', 3, { replacement_history: [typed], replacement_history_metadata: [{ history_sequence: 4 }] }),
    checkpoint, scope(5),
  );
  assert.equal(replayed.catalog.length, 1);
  assert.equal(replayed.capabilities.codexCatalogSources?.[0]?.status, 'unknown');

  const fresh = parse(
    record('response_item', 1, message(host)), scope(2),
    record('compacted', 3, { replacement_history: [typed], replacement_history_metadata: [{}] }),
    checkpoint, scope(5),
  );
  assert.deepEqual(fresh.catalog.map(row => [row.source, row.catalogEntries?.map(entry => entry.name)]), [
    ['codex_response_item', ['duplicate', 'duplicate']], ['codex_compaction_checkpoint', ['recovery']],
  ]);
  assert.equal(fresh.catalog[1]?.timestamp, '2026-07-01T00:00:03Z');
  assert.equal(fresh.capabilities.codexCatalogSources?.[0]?.status, 'observed');
});

test('Codex treats an existing name at a new locator as an ambiguous update', () => {
  const addition = block('Host skills update', ['- duplicate: Third. (file: /third/skill/SKILL.md)']);
  const parsed = parse(record('response_item', 1, message(host)), scope(2), record('response_item', 3, message(addition)), scope(4));
  const current = parsed.capabilities.codexCatalogSources?.[0];
  assert.equal(current?.status, 'unknown');
  assert.equal(parsed.catalog.length, 1);
  assert.deepEqual(parsed.catalog[0]?.catalogEntries?.map(entry => entry.sourceLocation), [
    '/original/skill/SKILL.md', '/other/skill/SKILL.md',
  ]);
});

test('Codex bounds aggregate retained catalog entries across incremental chunks', async () => {
  const { parseCodexSessionChunk } = await import('../src/parser/codex-sessions.js');
  const large = block('Host skills', Array.from({ length: 2_048 }, (_, index) =>
    '- skill-' + index + ': Description. (file: /large/' + index + '/SKILL.md)'));
  const epoch = [
    record('response_item', 1, message(large)), scope(2),
    record('response_item', 3, message('next turn', 'user')),
  ];
  const first = parseCodexSessionChunk([header, ...Array.from({ length: 7 }, () => epoch).flat()].join('\n'), 'codex-context');
  assert.equal(first.resumable, true);
  assert.equal(first.parsed.skillContext?.observations.length, 7);
  const rest = parseCodexSessionChunk([...epoch, ...epoch].join('\n'), 'codex-context', undefined, first.state);
  const entire = parse(...Array.from({ length: 9 }, () => epoch).flat());
  assert.equal(entire.catalog.length, 8);
  assert.equal(rest.parsed.skillContext?.observations.length, 1);
  assert.deepEqual(rest.parsed.skillContext?.capabilities, entire.capabilities);
  assert.deepEqual(entire.capabilities.codexCatalogSources, [{
    source: 'host', status: 'unknown', observedAt: '2026-07-01T00:00:01Z',
    projectIdentity: projectIdentityFromCwd('/work/current'), reason: 'context_history_limit',
  }]);
});

test('Codex requires fresh checkpoint provenance when compaction changes aliases for identical entries', () => {
  const before = block('Host skills', ['- original: Original. (file: r0/skill/SKILL.md)'], [root('r0', '/old')]);
  const after = block('Host skills', ['- original: Original. (file: r1/skill/SKILL.md)'], [root('r1', '/old'), root('r0', '/new')]);
  const update = block('Host skills update', ['- addition: Addition. (file: r0/addition/SKILL.md)']);
  const replacement = {
    ...message(after),
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['host_skills.instructions'],
      content_item_metadata: [{ provenance: { type: 'skills' } }],
    },
  };
  const checkpoint = record('world_state', 4, {
    full: true,
    state: { host_skills: { includeInstructions: true, body: after.split('\n').slice(1, -1).join('\n') } },
  });
  for (const replay of [true, false]) {
    const parsed = parse(
      record('response_item', 1, message(before)), scope(2),
      record('compacted', 3, { replacement_history: [replacement], replacement_history_metadata: [replay ? { history_sequence: 4 } : {}] }),
      checkpoint, scope(5),
      record('response_item', 6, message(update)), scope(7),
    );
    const current = parsed.capabilities.codexCatalogSources?.[0];
    if (replay) {
      assert.equal(current?.status, 'unknown');
      assert.equal(parsed.catalog.length, 1);
    } else {
      assert.equal(current?.status, 'observed');
      assert.deepEqual(current?.status === 'observed' && current.entries.map(entry => entry.sourceLocation), [
        '/old/skill/SKILL.md', '/new/addition/SKILL.md',
      ]);
      assert.deepEqual(parsed.catalog.map(row => [row.source, row.timestamp]), [
        ['codex_response_item', '2026-07-01T00:00:01Z'],
        ['codex_compaction_checkpoint', '2026-07-01T00:00:03Z'],
        ['codex_response_item', '2026-07-01T00:00:06Z'],
      ]);
    }
  }
});

test('Codex cannot apply a delta to a pre-compaction basis after opaque replacement', () => {
  const parsed = parse(
    record('response_item', 1, message(host)), scope(2),
    record('compacted', 3, { message: '' }),
    record('response_item', 4, message(delta)), scope(5),
  );
  assert.equal(parsed.catalog.length, 1);
  assert.equal(parsed.capabilities.codexCatalogSources?.[0]?.status, 'unknown');
});

test('Codex retains clipped historical evidence and requires a fresh full basis for deltas', () => {
  const clipped = block('Host skills', ['Exceeded skills context budget fixture warning']);
  const attempt = block('Host skills update', ['- restored: Restored. (file: /restored/SKILL.md)']);
  const partial = parse(record('response_item', 1, message(clipped)), scope(2));
  assert.equal(partial.catalog[0]?.metadata?.['truncation'], 'observed');
  assert.deepEqual(partial.catalog[0]?.catalogEntries, []);
  assert.deepEqual(partial.capabilities.codexCatalogSources?.map(source => [
    source.status, 'reason' in source && source.reason,
  ]), [['unknown', 'catalog_truncation_observed']]);

  const attempted = parse(
    record('response_item', 1, message(clipped)), scope(2),
    record('response_item', 3, message(attempt)), scope(4),
  );
  assert.equal(attempted.catalog.length, 1);
  assert.equal(attempted.capabilities.codexCatalogSources?.[0]?.status, 'unknown');

  const recovered = parse(
    record('response_item', 1, message(clipped)), scope(2),
    record('response_item', 3, message(host)), scope(4),
    record('response_item', 5, message(attempt)), scope(6),
  );
  assert.equal(recovered.catalog.length, 3);
  assert.equal(recovered.capabilities.codexCatalogSources?.[0]?.status, 'observed');
});

test('Codex preserves explicit legacy truncation without certifying a harness-wide basis', () => {
  const clipped = '<skills_instructions truncated=true><skills><skill><name>visible</name></skill></skills></skills_instructions>';
  const parsed = parse(record('response_item', 1, message(clipped)), scope(2));
  assert.equal(parsed.catalog[0]?.metadata?.['truncation'], 'observed');
  assert.equal(parsed.catalog[0]?.catalogEntries?.[0]?.name, 'visible');
  assert.equal((parsed.catalog[0]?.metadata?.['measurement'] as { value: number }).value, Buffer.byteLength(clipped));
  assert.equal(parsed.capabilities.codexCatalogSources?.[0]?.status, 'unknown');
});

test('Codex does not restore an older pending catalog after unsupported evidence with unknown source', async () => {
  const { parseCodexSessionChunk } = await import('../src/parser/codex-sessions.js');
  const opaque = record('response_item', 2, {
    ...message('<future_catalog>unsupported</future_catalog>'),
    internal_chat_message_metadata_passthrough: {
      content_item_metadata: [{ provenance: { type: 'skills' } }],
    },
  });
  const initial = [header, record('response_item', 1, message(host)), opaque];
  const companion = scope(3);
  const whole = parseCodexSessionChunk([...initial, companion].join('\n'), 'codex-context');
  assert.deepEqual(whole.parsed.skillContext?.observations, []);
  assert.equal(whole.parsed.skillContext?.capabilities.codexCatalogSources?.find(source => source.source === 'host')?.status, 'unknown');

  const first = parseCodexSessionChunk(initial.join('\n'), 'codex-context');
  assert.equal(first.resumable, true);
  const second = parseCodexSessionChunk(companion, 'codex-context', undefined, first.state);
  assert.deepEqual(second.parsed.skillContext, whole.parsed.skillContext);
});

test('Codex clears only matching pending catalog when unsupported evidence identifies its source', () => {
  const opaque = record('response_item', 2, {
    ...message('<future_catalog>unsupported host</future_catalog>'),
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['host_skills.instructions'],
      content_item_metadata: [{ provenance: { type: 'skills' } }],
    },
  });
  const parsed = parse(record('response_item', 1, message(host)), record('response_item', 1, message(cloud)), opaque, scope(3));
  assert.deepEqual(parsed.catalog.map(row => row.metadata?.['catalogSource']), ['cloud']);
  assert.deepEqual(parsed.capabilities.codexCatalogSources?.map(source => [source.source, source.status]), [
    ['host', 'unknown'], ['cloud', 'observed'],
  ]);
});
