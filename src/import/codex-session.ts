import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { discoverCodexRolloutFilesRecursive } from '../util/file-discovery.js';
import { readTranscriptFile } from '../util/transcript-file.js';
import { codexRolloutDependencyStamp, createCodexRolloutInventory, resolveCodexRolloutHistory, type CodexRolloutInventory } from '../util/codex-rollout-history.js';
import { discoverCodexLogs, hashContent, parseCodexFile } from './codex.js';
import type { CodexRolloutRead } from './index.js';
import type { ParsedImportEvent } from './claude-code.js';

export interface CodexSessionParse {
  events: ParsedImportEvent[];
  reads: Map<string, CodexRolloutRead>;
  malformedLines: number;
  paginated: boolean;
  ownedFiles: Set<string>;
  dependencyStamp?: string;
}

/** One immutable read per participating physical file, shared by parsing and hash commits. */
export function parseCodexSessionRollouts(
  filePath: string,
  options: { codexDir?: string; inventory?: CodexRolloutInventory; read?: CodexRolloutRead; usageInstrument?: 'counter'; from?: Date; to?: Date } = {},
): CodexSessionParse {
  filePath = path.resolve(filePath);
  let root = path.dirname(filePath);
  for (let directory = root; path.dirname(directory) !== directory; directory = path.dirname(directory)) {
    if (path.basename(directory) === 'sessions') { root = directory; break; }
  }
  const inventory = options.inventory ?? createCodexRolloutInventory([
    ...discoverCodexRolloutFilesRecursive(root),
    ...(options.codexDir ? discoverCodexLogs(options.codexDir) : []),
  ]);
  const entry = inventory.entries.find(entry => entry.filePath === filePath);
  const members = entry ? inventory.bySessionId.get(entry.sessionId) ?? [entry] : [];
  const paginated = members.length > 1 || !!entry?.historyBase || (entry !== undefined && entry.rolloutId !== entry.sessionId);
  if (entry?.historyError) throw entry.historyError;
  for (const [file, error] of inventory.errors) {
    if (entry && file.includes(`${entry.sessionId}_`)) throw error;
  }
  const ownedFiles = new Set(members.length ? members.map(member => member.filePath) : [filePath]);
  const reads = new Map<string, CodexRolloutRead>();
  if (options.read) reads.set(filePath, options.read);
  const readFile = (file: string): Buffer => {
    let read = reads.get(file);
    if (!read) {
      const stat = fs.statSync(file, { bigint: true });
      const bytes = readTranscriptFile(file);
      read = { bytes, hash: hashContent(bytes), mtime: stat.mtimeNs.toString(), size: Number(stat.size) };
      reads.set(file, read);
    }
    return read.bytes;
  };
  if (!paginated) {
    const diagnostics = { malformedLines: 0 };
    const events = parseCodexFile(filePath, { ...options, content: readFile(filePath).toString('utf8'), diagnostics });
    return { events, reads, malformedLines: diagnostics.malformedLines, paginated: false, ownedFiles };
  }
  // Native session identity alone does not prove every segment is readable.
  // Resolve every member before reconciliation; a missing base preserves the store.
  const ordered = [...members].sort((a, b) => Number(!!a.historyBase) - Number(!!b.historyBase) || a.filePath.localeCompare(b.filePath));
  const histories = ordered.map(member => resolveCodexRolloutHistory(member.filePath, { inventory, readFile }));
  // A full replacement can materialize its old prefix instead of pointing to
  // it. Only an exact chronological prefix proves shared history; equal totals
  // alone cannot distinguish a copy from another billable request.
  const comparable = histories.map(history => history.records.flatMap((record, index) => {
    if (record.value.type === 'session_meta') return [];
    const { ordinal: _ordinal, ...value } = record.value;
    return [{ index, value }];
  }));
  for (const [index, member] of ordered.entries()) {
    if (member.historyBase || member.rolloutId === member.sessionId) continue;
    const created = Date.parse(member.timestamp ?? '');
    let copied = 0;
    for (const [candidateIndex, candidate] of ordered.entries()) {
      if (candidateIndex === index) continue;
      const candidateCreated = Date.parse(candidate.timestamp ?? '');
      const older = candidate.rolloutId === member.sessionId
        || (Number.isFinite(created) && Number.isFinite(candidateCreated) && candidateCreated < created);
      if (!older) continue;
      let common = 0;
      while (common < comparable[index].length && common < comparable[candidateIndex].length
        && isDeepStrictEqual(comparable[index][common].value, comparable[candidateIndex][common].value)) common++;
      copied = Math.max(copied, common);
    }
    if (copied === 0) continue;
    const history = histories[index];
    history.ownFromLine = copied === comparable[index].length
      ? history.records.length : comparable[index][copied - 1].index + 1;
    history.records = history.records.map((record, recordIndex) => recordIndex > 0 && recordIndex < history.ownFromLine
      ? { ...record, inherited: true } : record);
  }
  const merged = new Map<string, ParsedImportEvent>();
  const ends: ParsedImportEvent[] = [];
  let malformedLines = 0;
  let expectedInput = 0;
  let expectedOutput = 0;
  let expectedKnown = true;
  let resets = 0;
  let unbilled = 0;
  for (const [index, history] of histories.entries()) {
    const member = ordered[index];
    const diagnostics = { malformedLines: 0 };
    const events = parseCodexFile(member.filePath, {
      ...options, content: history.content, diagnostics,
      history: member.historyBase || member.rolloutId !== member.sessionId
        ? { ownFromLine: history.ownFromLine, rolloutId: member.rolloutId } : undefined,
    });
    malformedLines += diagnostics.malformedLines;
    for (const event of events) {
      if (event.event_type === 'session_end') { ends.push(event); continue; }
      if (event.event_id && !merged.has(event.event_id)) merged.set(event.event_id, event);
    }
    const end = events.find(event => event.event_type === 'session_end')?.metadata as Record<string, unknown> | undefined;
    resets += Number(end?._counter_resets ?? 0);
    unbilled += Number(end?._compactions_unbilled ?? 0);
    // Independent native counter evidence for each file's own billed span.
    // Prefer thread totals (which include compactions) when both boundaries have them.
    const total = (inherited: boolean, useThread: boolean): { input: number; output: number } | undefined => {
      let last: { input: number; output: number } | undefined;
      for (const record of history.records) {
        if (inherited && !record.inherited) continue;
        const payload = record.value.payload as Record<string, unknown> | undefined;
        const info = payload?.info as Record<string, unknown> | undefined;
        const usage = useThread
          ? record.value.type === 'token_usage_record' && payload?.thread_id === history.sessionId ? payload.thread_token_usage : undefined
          : record.value.type === 'event_msg' && payload?.type === 'token_count' ? info?.total_token_usage : undefined;
        if (usage && typeof usage === 'object') {
          const value = usage as Record<string, unknown>;
          if (typeof value.input_tokens === 'number' && typeof value.output_tokens === 'number') last = { input: value.input_tokens, output: value.output_tokens };
        }
      }
      return last;
    };
    const inherited = history.records.some(record => record.inherited);
    const threadEnd = total(false, true);
    const threadStart = inherited ? total(true, true) : { input: 0, output: 0 };
    const final = threadEnd && threadStart ? threadEnd : total(false, false);
    const initial = threadEnd && threadStart ? threadStart : inherited ? total(true, false) : { input: 0, output: 0 };
    if (!final || !initial || final.input < initial.input || final.output < initial.output) expectedKnown = false;
    else { expectedInput += final.input - initial.input; expectedOutput += final.output - initial.output; }
  }
  const end = ends.sort((a, b) => (a.client_timestamp ?? '').localeCompare(b.client_timestamp ?? '')).at(-1);
  if (end?.event_id) {
    merged.set(end.event_id, { ...end, metadata: {
      ...end.metadata as Record<string, unknown>,
      _rollout_history: true,
      _rollout_files: members.length,
      _counter_resets: resets,
      _compactions_unbilled: unbilled,
      ...(expectedKnown ? { total_thread_tokens: { input_tokens: expectedInput, output_tokens: expectedOutput } } : { total_thread_tokens: undefined, _history_total_unknown: true }),
    } });
  }
  return { events: [...merged.values()], reads, malformedLines, paginated: true, ownedFiles,
    dependencyStamp: codexRolloutDependencyStamp(members, inventory, reads) };
}
