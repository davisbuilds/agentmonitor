import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { NormalizedIngestEvent } from '../contracts/event-contract.js';
import { findSubagentBoundary } from '../parser/codex-subagent-boundary.js';
import { pricingRegistry } from '../pricing/index.js';
import { parsePatchMeta } from '../otel/parser.js';
import { discoverCodexRolloutFilesRecursive } from '../util/file-discovery.js';
import { readTranscriptFile, transcriptBaseName } from '../util/transcript-file.js';
import { codexInvocationMode } from '../util/invocation-mode.js';
import { projectNameFromCwd } from '../util/project-identity.js';

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}


interface CodexLogLine {
  timestamp: string;
  type: string;
  payload: {
    id?: string;
    cwd?: string;
    originator?: string;
    timestamp?: string;
    model?: string;

    type?: string;
    info?: {
      total_token_usage?: CodexTokenUsage;
      last_token_usage?: CodexTokenUsage;
      model_context_window?: number;
    };

    role?: string;
    content?: Array<{ type: string; text?: string }>;

    [key: string]: unknown;
  };
}

interface CodexUsage3 {
  input: number;
  cached: number;
  output: number;
}

interface CodexUsageRecord {
  response_id: string;
  thread_id: string;
  timestamp: string;
  usage: CodexUsage3;
  thread: CodexUsage3;
  model?: string;
  model_source?: 'turn_context' | 'config';
}

function usage3(value: unknown): CodexUsage3 | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as CodexTokenUsage;
  const fields = [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens];
  if (!fields.every(field => typeof field === 'number' && Number.isFinite(field) && field >= 0)) return undefined;
  return { input: usage.input_tokens!, cached: usage.cached_input_tokens!, output: usage.output_tokens! };
}

function asUsageRecord(line: CodexLogLine): CodexUsageRecord | null {
  const payload = line.payload;
  const usage = usage3(payload.usage);
  const thread = usage3(payload.thread_token_usage);
  if (typeof payload.response_id !== 'string' || typeof payload.thread_id !== 'string' || !usage || !thread) return null;
  return { response_id: payload.response_id, thread_id: payload.thread_id, timestamp: line.timestamp, usage, thread };
}

const addUsage = (a: CodexUsage3, b: CodexUsage3): CodexUsage3 => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output });
const subtractUsage = (a: CodexUsage3, b: CodexUsage3): CodexUsage3 => ({ input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output });
const sameUsage = (a: CodexUsage3, b: CodexUsage3): boolean => a.input === b.input && a.cached === b.cached && a.output === b.output;

export function discoverCodexLogs(
  baseDir?: string,
  options: { excludePatterns?: string[] } = {},
): string[] {
  const codexHome = baseDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  return discoverCodexRolloutFilesRecursive(sessionsDir, { excludePatterns: options.excludePatterns });
}


function readCodexModel(codexHome?: string): string | undefined {
  const base = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(base, 'config.toml');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function parseCodexFile(
  filePath: string,
  options?: {
    from?: Date;
    to?: Date;
    codexDir?: string;
    /** The file's bytes when the caller already read them, so hash and parse see the same content. */
    content?: string;
    /** Filled in with what the parse had to skip. */
    diagnostics?: { malformedLines: number };
    /**
     * Bill from the cumulative counter even where per-request records would
     * allow one row per request: for an insert-only import of a session whose
     * counter rows are stored, which cannot delete the rows a switch replaces.
     */
    usageInstrument?: 'counter';
    /** Resolved ancestor lines initialize accounting but belong to other physical rollouts. */
    history?: { ownFromLine: number; rolloutId: string };
  },
): NormalizedIngestEvent[] {
  const events: NormalizedIngestEvent[] = [];
  const content = options?.content ?? readTranscriptFile(filePath).toString('utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const defaultModel = readCodexModel(options?.codexDir);

  const parsedLines = lines.map(rawLine => {
    try {
      return JSON.parse(rawLine) as CodexLogLine;
    } catch {
      return null;
    }
  });
  if (options?.diagnostics) options.diagnostics.malformedLines = parsedLines.filter(line => line === null).length;
  // WHY: A copied parent record is context and does not establish ownership of its source file.
  const authoritativeHeader = parsedLines.find(line => line?.type === 'session_meta');
  if (!options?.history && authoritativeHeader?.payload?.history_base != null) {
    throw new Error('Invalid Codex rollout history: paginated usage requires resolved ancestor accounting');
  }
  // WHY: Before the fork boundary, copied lines advance the counter but still belong to the parent.
  const boundary = findSubagentBoundary(parsedLines);
  const ownFrom = Math.max(boundary.kind === 'resolved' ? boundary.line : 0, options?.history?.ownFromLine ?? 0);
  let inheritedCountersSkipped = 0;
  // WHY: A falling cumulative counter marks a reset; later growth is new usage.
  let counterResets = 0;

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let sessionTimestamp: string | undefined;
  let originator: string | undefined;
  let firstTurnModel: string | undefined;

  for (const [lineIndex, line] of parsedLines.entries()) {
    if (!line) continue;

    if (line.type === 'session_meta' && !sessionId) {
      sessionId = line.payload.id;
      cwd = line.payload.cwd;
      sessionTimestamp = line.payload.timestamp ?? line.timestamp;
      originator = line.payload.originator;
    }
    if (
      line.type === 'turn_context' && !firstTurnModel && lineIndex >= ownFrom
      && typeof line.payload.model === 'string'
    ) {
      firstTurnModel = line.payload.model;
    }
  }

  const mode = codexInvocationMode(originator);

  // WHY: Native per-request usage records include compactions that the cumulative counter can omit.
  const usageRecords = new Map<string, CodexUsageRecord>();
  for (const line of parsedLines) {
    if (!line || line.type !== 'token_usage_record') continue;
    const record = asUsageRecord(line);
    if (record && record.thread_id === sessionId && !usageRecords.has(record.response_id)) {
      usageRecords.set(record.response_id, record);
    }
  }

  let instrument: 'request' | 'counter' = 'counter';
  const namedCompactions = new Set<string>();
  const ownRecords = new Map<string, CodexUsageRecord>();
  let lastRecord: CodexUsageRecord | undefined;
  let unreadable = false;
  let inheritedThread: CodexUsage3 = { input: 0, cached: 0, output: 0 };
  let lastCounter = { input: 0, output: 0 };
  const counterGrowth = { input: 0, output: 0 };
  for (const [lineIndex, line] of parsedLines.entries()) {
    if (options?.usageInstrument === 'counter') break;
    if (!line) {
      if (lineIndex >= ownFrom && lineIndex < parsedLines.length - 1) unreadable = true;
      continue;
    }
    const counted = line.type === 'event_msg' && line.payload?.type === 'token_count' ? line.payload.info?.total_token_usage : undefined;
    if (counted) {
      const current = { input: counted.input_tokens ?? 0, output: counted.output_tokens ?? 0 };
      if (lineIndex >= ownFrom) {
        counterGrowth.input += Math.max(0, current.input - lastCounter.input);
        counterGrowth.output += Math.max(0, current.output - lastCounter.output);
      }
      lastCounter = current;
    }
    if (lineIndex < ownFrom) {
      const record = line.type === 'token_usage_record' ? asUsageRecord(line) : null;
      if (record && record.thread_id === sessionId) inheritedThread = record.thread;
      continue;
    }
    if (line.type === 'compacted' && typeof line.payload.compaction_response_id === 'string') {
      namedCompactions.add(line.payload.compaction_response_id);
    }
    if (line.type !== 'token_usage_record') continue;
    const record = asUsageRecord(line);
    if (!record || record.thread_id !== sessionId) continue;
    if (!ownRecords.has(record.response_id)) ownRecords.set(record.response_id, record);
    lastRecord = record;
  }
  const firstRecord = ownRecords.values().next().value;
  if (firstRecord && lastRecord && !unreadable && sameUsage(firstRecord.usage, subtractUsage(firstRecord.thread, inheritedThread))) {
    const sum = [...ownRecords.values()].reduce((total, record) => addUsage(total, record.usage), { input: 0, cached: 0, output: 0 });
    const ownTotal = subtractUsage(lastRecord.thread, inheritedThread);
    const covered = counterGrowth.input <= ownTotal.input && counterGrowth.output <= ownTotal.output;
    if (sameUsage(sum, ownTotal) && covered) instrument = 'request';
  }

  if (!sessionId) {
    const basename = transcriptBaseName(filePath);
    const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = uuidMatch?.[1] ?? basename;
  }

  const project = projectNameFromCwd(cwd) ?? undefined;
  // WHY: Reverts retain the native session ID but start another physical rollout; positional IDs
  // must not overwrite earlier requests.
  const positionalId = options?.history ? `${sessionId}:rollout:${options.history.rolloutId}` : sessionId;

  if (sessionTimestamp && options?.from) {
    const ts = new Date(sessionTimestamp);
    if (ts < options.from) return events;
  }
  if (sessionTimestamp && options?.to) {
    const ts = new Date(sessionTimestamp);
    if (ts > options.to) return events;
  }

  let prevTokensIn = 0;
  let prevTokensOut = 0;
  let prevCacheRead = 0;
  let eventIndex = 0;
  // WHY: Charge compaction only when its growth accounts for the gap in the thread counter.
  let threadTotal: CodexUsage3 | undefined;
  let counterGap: CodexUsage3 | undefined;
  let pendingCompactions: CodexUsageRecord[] = [];
  const billedResponses = new Set<string>();
  let compactionsUnbilled = 0;
  let currentModel = defaultModel;
  let currentModelSource: 'turn_context' | 'config' | undefined = defaultModel ? 'config' : undefined;

  /**
   * Bill the held compactions when the counter's gap to the thread total grew
   * by exactly their usage since the last counter; otherwise none of them, and
   * count them. `gap` is undefined when it cannot be measured (no record yet,
   * or the counter reset).
   */
  const settleCompactions = (gap: CodexUsage3 | undefined): void => {
    if (pendingCompactions.length === 0) return;
    const held = pendingCompactions;
    pendingCompactions = [];
    const sum = held.reduce((total, record) => addUsage(total, record.usage), { input: 0, cached: 0, output: 0 });
    if (!gap || !counterGap || !sameUsage(subtractUsage(gap, counterGap), sum)) {
      compactionsUnbilled += held.length;
      return;
    }
    for (const record of held) {
      billedResponses.add(record.response_id);
      pushRequest(record, 'compaction');
    }
  };

  /** One request's usage as its own row, keyed by its response. */
  function pushRequest(record: CodexUsageRecord, usageSource: 'request' | 'compaction'): void {
    const uncached = Math.max(0, record.usage.input - record.usage.cached);
    const costUsd = record.model
      ? pricingRegistry.calculate(record.model, { input: uncached, output: record.usage.output, cacheRead: record.usage.cached }, record.timestamp)
      : undefined;
    const eventId = crypto
      .createHash('sha256')
      .update(`codex:${sessionId}:response:${record.response_id}`)
      .digest('hex')
      .slice(0, 32);
    events.push({
      event_id: `import-cdx-${eventId}`,
      session_id: sessionId!,
      agent_type: 'codex',
      event_type: 'llm_response',
      status: 'success',
      tokens_in: uncached,
      tokens_out: record.usage.output,
      cache_read_tokens: record.usage.cached,
      model: record.model,
      cost_usd: costUsd ?? undefined,
      cost_source: costUsd != null ? 'estimated' : undefined,
      project,
      client_timestamp: record.timestamp,
      metadata: {
        _synthetic: true,
        _source: 'codex_session_jsonl',
        _model_source: record.model_source,
        _usage_source: usageSource,
        _response_id: record.response_id,
      },
      source: 'import',
    });
  }

  for (const [lineIndex, line] of parsedLines.entries()) {
    if (!line) continue;
    const inherited = lineIndex < ownFrom;

    if (line.type === 'session_meta') {
      const eventId = crypto
        .createHash('sha256')
        .update(`codex:${sessionId}:meta`)
        .digest('hex')
        .slice(0, 32);

      events.push({
        event_id: `import-cdx-${eventId}`,
        session_id: sessionId,
        agent_type: 'codex',
        event_type: 'session_start',
        status: 'success',
        tokens_in: 0,
        tokens_out: 0,
        model: firstTurnModel ?? defaultModel,
        project,
        client_timestamp: line.timestamp,
        metadata: {
          originator,
          cwd,
          _model_source: firstTurnModel ? 'turn_context' : currentModelSource,
          ...(options?.history ? { _rollout_id: options.history.rolloutId } : {}),
          ...(boundary.kind === 'none' ? {} : { _subagent_boundary: boundary.kind }),
        },
        source: 'import',
      });
      continue;
    }

    // WHY: The session log records the selected model per turn. The current config cannot establish
    // which model ran an earlier request.
    if (line.type === 'turn_context' && typeof line.payload?.model === 'string') {
      currentModel = line.payload.model;
      currentModelSource = 'turn_context';
      continue;
    }

    if (line.type === 'token_usage_record') {
      const record = asUsageRecord(line);
      if (!record || record.thread_id !== sessionId) continue;
      threadTotal = record.thread;
      if (!inherited && instrument === 'request' && !billedResponses.has(record.response_id)) {
        billedResponses.add(record.response_id);
        pushRequest(
          { ...record, model: currentModel, model_source: currentModelSource },
          namedCompactions.has(record.response_id) ? 'compaction' : 'request',
        );
      }
      continue;
    }

    if (line.type === 'compacted') {
      // WHY: A native per-request record already includes the compaction it identifies.
      if (inherited || instrument === 'request') continue;
      const responseId = typeof line.payload.compaction_response_id === 'string' ? line.payload.compaction_response_id : undefined;
      if (!responseId || billedResponses.has(responseId) || pendingCompactions.some(r => r.response_id === responseId)) continue;
      const record = usageRecords.get(responseId);
      if (record) pendingCompactions.push({ ...record, model: currentModel, model_source: currentModelSource });
      else compactionsUnbilled++;
      continue;
    }

    if (line.type === 'event_msg' && line.payload?.type === 'token_count') {
      const usage = line.payload.info?.total_token_usage;
      if (!usage) continue;

      const totalIn = (usage.input_tokens ?? 0);
      const totalOut = (usage.output_tokens ?? 0);
      const totalCacheRead = (usage.cached_input_tokens ?? 0);

      const reset = totalIn < prevTokensIn || totalOut < prevTokensOut;
      if (reset) counterResets++;
      {
        const gap = threadTotal ? subtractUsage(threadTotal, { input: totalIn, cached: totalCacheRead, output: totalOut }) : undefined;
        if (!inherited) settleCompactions(gap);
        counterGap = gap;
      }

      const deltaIn = totalIn - prevTokensIn;
      const deltaOut = totalOut - prevTokensOut;
      const deltaCacheRead = totalCacheRead - prevCacheRead;

      prevTokensIn = totalIn;
      prevTokensOut = totalOut;
      prevCacheRead = totalCacheRead;

      // WHY: Codex input totals include cached input. Charging the full total at the uncached rate
      // would bill it twice.
      const deltaInputUncached = Math.max(0, deltaIn - deltaCacheRead);

      if (deltaIn <= 0 && deltaOut <= 0) continue;
      // WHY: Preserve the counter record's ordinal even when per-request records own billing, so
      // unrelated event IDs stay stable.
      if (inherited || instrument === 'request') {
        if (inherited) inheritedCountersSkipped++;
        eventIndex++;
        continue;
      }

      const eventId = crypto
        .createHash('sha256')
        .update(`codex:${positionalId}:token:${eventIndex}`)
        .digest('hex')
        .slice(0, 32);

      const costUsd = currentModel
        ? pricingRegistry.calculate(currentModel, {
            input: deltaInputUncached,
            output: deltaOut,
            cacheRead: deltaCacheRead,
          }, line.timestamp)
        : undefined;

      events.push({
        event_id: `import-cdx-${eventId}`,
        session_id: sessionId,
        agent_type: 'codex',
        event_type: 'llm_response',
        status: 'success',
        tokens_in: deltaInputUncached,
        tokens_out: deltaOut,
        cache_read_tokens: deltaCacheRead,
        model: currentModel,
        cost_usd: costUsd ?? undefined,
        cost_source: costUsd != null ? 'estimated' : undefined,
        project,
        client_timestamp: line.timestamp,
        metadata: {
          _synthetic: true,
          _source: 'codex_session_jsonl',
          _model_source: currentModelSource,
        },
        source: 'import',
      });

      eventIndex++;
      continue;
    }

    if (line.type === 'response_item') {
      const payload = line.payload as Record<string, unknown>;
      let patchContent: string | undefined;

      if (payload.name === 'apply_patch' && typeof payload.input === 'string') {
        patchContent = payload.input;
      } else if (payload.name === 'exec_command' && typeof payload.arguments === 'string') {
        try {
          const args = JSON.parse(payload.arguments) as { cmd?: string };
          if (args.cmd && args.cmd.startsWith('apply_patch')) {
            patchContent = args.cmd;
          }
        } catch {
          // WHY: An older producer may store the shell-form patch directly in arguments.
          if (payload.arguments.startsWith('apply_patch') || payload.arguments.includes('*** Begin Patch')) {
            patchContent = payload.arguments;
          }
        }
      }

      if (patchContent) {
        const patchMeta = parsePatchMeta(patchContent);
        if (patchMeta && inherited) {
          eventIndex++;
        } else if (patchMeta) {
          const eventId = crypto
            .createHash('sha256')
            .update(`codex:${positionalId}:patch:${eventIndex}`)
            .digest('hex')
            .slice(0, 32);

          events.push({
            event_id: `import-cdx-${eventId}`,
            session_id: sessionId,
            agent_type: 'codex',
            event_type: 'tool_use',
            tool_name: 'apply_patch',
            status: 'success',
            tokens_in: 0,
            tokens_out: 0,
            project,
            client_timestamp: line.timestamp,
            metadata: {
              file_path: patchMeta.file_path,
              lines_added: patchMeta.lines_added,
              lines_removed: patchMeta.lines_removed,
            },
            source: 'import',
          });

          eventIndex++;
        }
        continue;
      }
    }

  }

  if (pendingCompactions.length > 0) {
    settleCompactions(threadTotal ? subtractUsage(threadTotal, { input: prevTokensIn, cached: prevCacheRead, output: prevTokensOut }) : undefined);
  }

  if (events.length > 0) {
    const lastTimestamp = lines.length > 0
      ? (() => { try { return (JSON.parse(lines[lines.length - 1]) as CodexLogLine).timestamp; } catch { return undefined; } })()
      : undefined;

    const eventId = crypto
      .createHash('sha256')
      .update(`codex:${sessionId}:end`)
      .digest('hex')
      .slice(0, 32);

    events.push({
      event_id: `import-cdx-${eventId}`,
      session_id: sessionId,
      agent_type: 'codex',
      event_type: 'session_end',
      status: 'success',
      tokens_in: 0,
      tokens_out: 0,
      model: currentModel,
      project,
      client_timestamp: lastTimestamp,
      metadata: {
        total_tokens_in: prevTokensIn,
        total_tokens_out: prevTokensOut,
        total_cache_read: prevCacheRead,
        _model_source: currentModelSource,
        _usage_instrument: instrument,
        ...(boundary.kind === 'resolved' ? { _inherited_counters_skipped: inheritedCountersSkipped } : {}),
        ...(counterResets > 0 ? { _counter_resets: counterResets } : {}),
        ...(threadTotal ? {
          total_thread_tokens: { input_tokens: threadTotal.input, cached_input_tokens: threadTotal.cached, output_tokens: threadTotal.output },
        } : {}),
        ...(compactionsUnbilled > 0 ? { _compactions_unbilled: compactionsUnbilled } : {}),
      },
      source: 'import',
    });
  }

  return mode || options?.history ? events.map(event => ({
    ...event,
    ...(mode ? { mode } : {}),
    ...(options?.history ? { metadata: { ...event.metadata as Record<string, unknown>, _rollout_id: options.history.rolloutId } } : {}),
  })) : events;
}


export function hashFile(filePath: string): string {
  return hashContent(readTranscriptFile(filePath));
}

export function hashContent(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
