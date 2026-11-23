import path from 'node:path';
import { findSubagentBoundary } from '../parser/codex-subagent-boundary.js';
import {
  codexPhysicalRolloutId, createCodexRolloutInventory, currentCodexRollout, discoverCodexRolloutSiblings,
  resolveCodexRolloutHistory, type CodexRolloutEntry, type CodexRolloutInventory,
} from '../util/codex-rollout-history.js';
import { readTranscriptFile, transcriptBaseName } from '../util/transcript-file.js';

export interface ToolTimingInterval {
  callId: string;
  toolName: string;
  startedAt: number;
  returnedAt: number;
  reportedMs: number | null;
  reportedSource?: ReportedTimer['source'];
}

export interface ToolTimingCoverage {
  status: 'available' | 'partial' | 'unavailable';
  filesRead: number;
  malformedRecords: number;
  openCalls: number;
  unmatchedReturns: number;
  invalidIntervals: number;
  duplicateCalls: number;
  copiedRecords: number;
  unresolvedFiles: number;
}

export interface ToolTimingReadout {
  intervals: ToolTimingInterval[];
  coverage: ToolTimingCoverage;
}

export interface ToolTimingInput {
  source: 'codex' | 'claude-code';
  sessionId: string;
  filePaths: readonly string[];
  codexInventory?: CodexRolloutInventory;
}

type NativeRecord = Record<string, unknown>;
type ToolCall = { name: string; timestamp: number | null; kind: 'function' | 'custom' | 'claude'; assistantId?: string };
type ReportedTimer =
  | { source: 'codex_code_mode_wall_time'; milliseconds: number }
  | { source: 'codex_shell_wall_time'; milliseconds: number; shell: 'unified' | 'shell_command' }
  | { source: 'claude_webfetch_duration_ms'; milliseconds: number; assistantId: string };
type TimingEvent = { id: string; call: ToolCall } | {
  id: string;
  timestamp: number | null;
  kind: ToolCall['kind'];
  timer: ReportedTimer | null;
};

const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;

function asRecord(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : undefined;
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 200 && SAFE_TOKEN.test(value) ? value : undefined;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function* readJsonl(bytes: Buffer, coverage: ToolTimingCoverage): Generator<NativeRecord> {
  const content = bytes.toString('utf8');
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline < 0 ? content.length : newline;
    const line = content.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    let record: NativeRecord | undefined;
    try { record = asRecord(JSON.parse(line)); } catch { /* WHY: Malformed records count toward coverage below even when JSON parsing fails. */ }
    if (record) yield record;
    else coverage.malformedRecords++;
  }
}

function milliseconds(match: RegExpExecArray): number | null {
  const result = Number(match[1]) * 1_000;
  return result <= Number.MAX_SAFE_INTEGER ? result : null;
}

/** Detect only native leading timing frames, never text following the output delimiter. */
function codexReportedTimer(output: unknown): ReportedTimer | null {
  const block = Array.isArray(output) ? asRecord(output[0]) : undefined;
  const text = typeof output === 'string' ? output : block?.type === 'input_text' ? block.text : undefined;
  if (typeof text !== 'string') return null;
  const header = text.slice(0, 4096);
  const codeMode = /^Script (?:completed|failed|running with cell ID [A-Za-z0-9:_.-]+)\r?\nWall time:? (\d+(?:\.\d+)?) seconds\r?\n(?:Output:|Final output:)(?:\r?\n|$)/.exec(header);
  if (codeMode) {
    const duration = milliseconds(codeMode);
    return duration === null ? null : { source: 'codex_code_mode_wall_time', milliseconds: duration };
  }
  const shellCommand = /^Exit code: -?\d+\r?\nWall time: (\d+(?:\.\d+)?) seconds\r?\nOutput:(?:\r?\n|$)/.exec(header);
  if (shellCommand) {
    const duration = milliseconds(shellCommand);
    return duration === null ? null : { source: 'codex_shell_wall_time', shell: 'shell_command', milliseconds: duration };
  }
  const direct = header.replace(/^Command: [\w./-]+ -[a-z]+ (?:'[^'\r\n]*'|"(?:[^"\\\r\n]|\\[^\r\n])*")\r?\n(?=Chunk ID: )/, '');
  const unified = /^(?:Chunk ID: [a-f0-9]+\r?\n)?Wall time: (\d+(?:\.\d+)?) seconds\r?\n(?:Process exited with code -?\d+\r?\n|Process running with session ID \d+\r?\n)(?:Original token count: \d+\r?\n)?(?:Output:|Final output:)(?:\r?\n|$)/.exec(direct);
  if (!unified) return null;
  const duration = milliseconds(unified);
  return duration === null ? null : { source: 'codex_shell_wall_time', shell: 'unified', milliseconds: duration };
}

function matchedTimer(timer: ReportedTimer | null, call: ToolCall): ReportedTimer | null {
  if (!timer) return null;
  if (timer.source === 'claude_webfetch_duration_ms') {
    return call.name === 'WebFetch' && call.assistantId === timer.assistantId ? timer : null;
  }
  const name = call.name.replace(/^functions\./, '');
  if (timer.source === 'codex_code_mode_wall_time') {
    return (name === 'exec' && call.kind === 'custom') || (name === 'wait' && call.kind === 'function') ? timer : null;
  }
  const accepted = timer.shell === 'unified' ? name === 'exec_command' || name === 'write_stdin' : name === 'shell_command';
  return accepted && call.kind === 'function' ? timer : null;
}

function* codexToolEvents(records: Iterable<NativeRecord>, coverage: ToolTimingCoverage): Generator<TimingEvent> {
  for (const record of records) {
    if (record.type !== 'response_item') continue;
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const type = payload.type;
    switch (type) {
      case 'function_call':
      case 'custom_tool_call': {
        const id = token(payload.call_id);
        const name = token(payload.name);
        const hasNamespace = payload.namespace != null && payload.namespace !== '';
        const namespace = hasNamespace ? token(payload.namespace) : undefined;
        const qualifiedName = name && (!hasNamespace || namespace) ? token(namespace ? `${namespace}.${name}` : name) : undefined;
        if (!id || !qualifiedName) { coverage.invalidIntervals++; continue; }
        yield { id, call: { name: qualifiedName, timestamp: parseTimestamp(record.timestamp), kind: type === 'function_call' ? 'function' : 'custom' } };
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = token(payload.call_id);
        if (!id) { coverage.invalidIntervals++; continue; }
        yield { id, timestamp: parseTimestamp(record.timestamp), kind: type === 'function_call_output' ? 'function' : 'custom',
          timer: codexReportedTimer(payload.output) };
        break;
      }
    }
  }
}

function* claudeToolEvents(records: Iterable<NativeRecord>, isSubagent: boolean, coverage: ToolTimingCoverage): Generator<TimingEvent> {
  for (const record of records) {
    if (Boolean(record.isSidechain) !== isSubagent) continue;
    const message = asRecord(record.message);
    if (!Array.isArray(message?.content)) continue;
    const timestamp = parseTimestamp(record.timestamp);
    const assistantId = token(record.uuid);
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock);
      if (record.type === 'assistant' && block?.type === 'tool_use') {
        const id = token(block.id);
        const name = token(block.name);
        if (!id || !name) { coverage.invalidIntervals++; continue; }
        yield { id, call: { name, timestamp, kind: 'claude', assistantId } };
      } else if (record.type === 'user' && block?.type === 'tool_result') {
        const id = token(block.tool_use_id);
        if (!id) { coverage.invalidIntervals++; continue; }
        // WHY: WebFetch reports elapsed time for the host result envelope and cannot time multiple
        // calls independently.
        const owner = token(record.sourceToolAssistantUUID);
        const duration = asRecord(record.toolUseResult)?.durationMs;
        const timer = message.content.length === 1 && owner && typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0
          ? { source: 'claude_webfetch_duration_ms' as const, milliseconds: duration, assistantId: owner } : null;
        yield { id, timestamp, kind: 'claude', timer };
      }
    }
  }
}

function pairCalls(events: Iterable<TimingEvent>, coverage: ToolTimingCoverage): ToolTimingInterval[] {
  const pending = new Map<string, ToolCall>();
  const closed = new Set<string>();
  const intervals: ToolTimingInterval[] = [];
  for (const event of events) {
    if ('call' in event) {
      const earlier = pending.get(event.id);
      if (earlier || closed.has(event.id)) coverage.duplicateCalls++;
      if (!closed.has(event.id) && (!earlier || earlier.timestamp === null)) pending.set(event.id, event.call);
      continue;
    }
    if (closed.has(event.id)) continue;
    const call = pending.get(event.id);
    if (!call || call.kind !== event.kind) { coverage.unmatchedReturns++; continue; }
    pending.delete(event.id);
    closed.add(event.id);
    const { timestamp: startedAt, name: toolName } = call;
    const returnedAt = event.timestamp;
    if (startedAt === null || returnedAt === null || returnedAt < startedAt) {
      coverage.invalidIntervals++;
      continue;
    }
    const timer = matchedTimer(event.timer, call);
    intervals.push({ callId: event.id, toolName, startedAt, returnedAt, reportedMs: timer?.milliseconds ?? null,
      ...(timer ? { reportedSource: timer.source } : {}) });
  }
  coverage.openCalls = pending.size;
  return intervals.sort((a, b) => a.startedAt - b.startedAt || a.returnedAt - b.returnedAt || a.callId.localeCompare(b.callId));
}

function completeCodexInventory(
  active: CodexRolloutEntry, inventory: CodexRolloutInventory, readFile: (filePath: string) => Buffer,
): CodexRolloutInventory {
  const files = new Set(inventory.entries.map(entry => entry.filePath));
  let siblings: string[] | undefined;
  const seen = new Set<string>();
  let id = active.historyBase?.thread_id;
  while (id && !seen.has(id) && seen.size < 128) {
    seen.add(id);
    if (!inventory.byRolloutId.has(id)) {
      siblings ??= discoverCodexRolloutSiblings(active.filePath);
      const matching = siblings.filter(file => codexPhysicalRolloutId(file) === id);
      matching.forEach(file => files.add(file));
      if (matching.length) inventory = createCodexRolloutInventory([...files], readFile);
    }
    const candidates = inventory.byRolloutId.get(id);
    id = candidates?.length === 1 ? candidates[0].historyBase?.thread_id : undefined;
  }
  return inventory;
}

function ownCodexRecords(
  all: Iterable<NativeRecord>, sessionId: string, coverage: ToolTimingCoverage,
): Iterable<NativeRecord> {
  const iterator = all[Symbol.iterator]();
  const header = iterator.next().value as NativeRecord | undefined;
  const meta = asRecord(header?.payload);
  if (header?.type !== 'session_meta' || meta?.id !== sessionId) throw new Error('Missing Codex transcript identity');
  const rows = { [Symbol.iterator]: () => iterator };
  const source = asRecord(meta.source);
  const spawn = asRecord(source?.subagent)?.thread_spawn;
  const ordinal = meta.subagent_history_start_ordinal;
  if (typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0) {
    return (function* () {
      for (const row of rows) {
        if (typeof row.ordinal !== 'number') { coverage.malformedRecords++; continue; }
        if (row.ordinal >= ordinal) yield row;
        else coverage.copiedRecords++;
      }
    })();
  }
  if (!spawn && meta.thread_source !== 'subagent') return rows;
  const records = [header, ...rows];
  const boundary = findSubagentBoundary(records.map(row => ({
    type: typeof row.type === 'string' ? row.type : undefined,
    payload: asRecord(row.payload),
  })), meta.thread_source === 'subagent');
  if (boundary.kind !== 'resolved') throw new Error('Unresolved Codex subagent boundary');
  coverage.copiedRecords += boundary.line - 1;
  return records.slice(boundary.line);
}

function* readCodexEvents(
  input: ToolTimingInput, paths: string[], readFile: (filePath: string) => Buffer, coverage: ToolTimingCoverage,
): Generator<TimingEvent> {
  let inventory = input.codexInventory ?? createCodexRolloutInventory(paths, readFile);
  // WHY: A compressed copy can vanish during a concurrent materialization.
  coverage.unresolvedFiles += paths.filter(file => inventory.errors.has(file)
    && !inventory.entries.some(entry => entry.filePath === file)).length;
  const sameSession = inventory.bySessionId.get(input.sessionId) ?? [];
  const first = sameSession.find(entry => paths.includes(entry.filePath)) ?? sameSession[0];
  if (!first) {
    if (paths.length && !coverage.unresolvedFiles) coverage.unresolvedFiles++;
    return;
  }
  try {
    const active = currentCodexRollout(first, inventory);
    if (active.historyError) throw active.historyError;
    let filesRead = 1;
    let records: Iterable<NativeRecord>;
    if (active.historyBase) {
      inventory = completeCodexInventory(active, inventory, readFile);
      const history = resolveCodexRolloutHistory(active.filePath, { inventory, readFile, maxBytes: MAX_DECODED_BYTES });
      filesRead = history.segments.length;
      records = (function* () {
        for (const record of history.records) {
          if (record.sessionId === input.sessionId) {
            yield record.value;
          } else {
            coverage.copiedRecords++;
          }
        }
      })();
    } else {
      records = readJsonl(readFile(active.filePath), coverage);
    }
    yield* codexToolEvents(ownCodexRecords(records, input.sessionId, coverage), coverage);
    coverage.filesRead = filesRead;
  } catch {
    coverage.unresolvedFiles++;
  }
}

function* readClaudeEvents(
  sessionId: string, paths: string[], readFile: (filePath: string) => Buffer, coverage: ToolTimingCoverage,
): Generator<TimingEvent> {
  const isSubagent = sessionId.startsWith('agent-');
  for (const file of paths) {
    if (transcriptBaseName(file) !== sessionId) { coverage.unresolvedFiles++; continue; }
    try {
      yield* claudeToolEvents(readJsonl(readFile(file), coverage), isSubagent, coverage);
      coverage.filesRead++;
    } catch {
      coverage.unresolvedFiles++;
    }
  }
}

export function readToolTiming(input: ToolTimingInput): ToolTimingReadout {
  const coverage: ToolTimingCoverage = {
    status: 'unavailable', filesRead: 0, malformedRecords: 0, openCalls: 0, unmatchedReturns: 0,
    invalidIntervals: 0, duplicateCalls: 0, copiedRecords: 0, unresolvedFiles: 0,
  };
  const paths = [...new Set(input.filePaths.map(file => path.resolve(file)))];
  let remainingBytes = MAX_DECODED_BYTES;
  const reads = new Map<string, Buffer>();
  const readFile = (file: string) => {
    const existing = reads.get(file);
    if (existing) return existing;
    if (remainingBytes <= 0) throw new Error('Transcript exceeds read budget');
    const bytes = readTranscriptFile(file, remainingBytes);
    reads.set(file, bytes);
    remainingBytes -= bytes.length;
    return bytes;
  };
  const events = input.source === 'codex'
    ? readCodexEvents(input, paths, readFile, coverage)
    : readClaudeEvents(input.sessionId, paths, readFile, coverage);
  const intervals = pairCalls(events, coverage);
  if (coverage.filesRead) {
    coverage.status = coverage.malformedRecords || coverage.openCalls || coverage.unmatchedReturns
      || coverage.invalidIntervals || coverage.unresolvedFiles ? 'partial' : 'available';
  }
  return { intervals, coverage };
}
