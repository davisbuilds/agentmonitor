import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { NormalizedIngestEvent } from '../contracts/event-contract.js';
import { findSubagentBoundary } from '../parser/codex-subagent-boundary.js';
import { pricingRegistry } from '../pricing/index.js';
import { parsePatchMeta } from '../otel/parser.js';
import { discoverJsonlFilesRecursive } from '../util/file-discovery.js';
import { codexInvocationMode } from '../util/invocation-mode.js';
import { projectNameFromCwd } from '../util/project-identity.js';

// ─── Codex JSONL line types ─────────────────────────────────────────────

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
    // session_meta
    id?: string;
    cwd?: string;
    originator?: string;
    timestamp?: string;
    model?: string;

    // event_msg
    type?: string;
    info?: {
      total_token_usage?: CodexTokenUsage;
      last_token_usage?: CodexTokenUsage;
      model_context_window?: number;
    };

    // response_item
    role?: string;
    content?: Array<{ type: string; text?: string }>;

    // generic fields from OTEL-style
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

// ─── Discover JSONL files ──────────────────────────────────────────────

export function discoverCodexLogs(
  baseDir?: string,
  options: { excludePatterns?: string[] } = {},
): string[] {
  const codexHome = baseDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  return discoverJsonlFilesRecursive(sessionsDir, { excludePatterns: options.excludePatterns });
}

// ─── Read model from config.toml ────────────────────────────────────────

function readCodexModel(codexHome?: string): string | undefined {
  const base = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(base, 'config.toml');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Simple parse for top-level model = "..."
    const match = content.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ─── Parse a single JSONL file ──────────────────────────────────────────

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
  },
): NormalizedIngestEvent[] {
  const events: NormalizedIngestEvent[] = [];
  const content = options?.content ?? fs.readFileSync(filePath, 'utf-8');
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
  // In a subagent that opens with a copy of its parent's history, lines before
  // the boundary are the parent's: they advance the counters and the event
  // index (so the child's own event ids stay what they always were) but emit
  // nothing.
  const boundary = findSubagentBoundary(parsedLines);
  const ownFrom = boundary.kind === 'resolved' ? boundary.line : 0;
  let inheritedCountersSkipped = 0;
  // A cumulative counter that drops has restarted: what it bills after the drop
  // is new usage, so the rollout's final counter understates the session.
  let counterResets = 0;

  // First pass: extract session metadata
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

  // Codex writes one `token_usage_record` per API request (0.154+), including
  // compaction requests its cumulative `token_count` leaves out. Index this
  // thread's own records so a `compacted` line can bill the request it names;
  // a copied prefix's `compacted` lines are skipped where they are read.
  const usageRecords = new Map<string, CodexUsageRecord>();
  for (const line of parsedLines) {
    if (!line || line.type !== 'token_usage_record') continue;
    const record = asUsageRecord(line);
    if (record && record.thread_id === sessionId && !usageRecords.has(record.response_id)) {
      usageRecords.set(record.response_id, record);
    }
  }

  // Records that start at the thread's first request (the first one's usage is
  // the whole thread so far) cover every request, so they are billed one row
  // each. Records that start mid-thread, as in a session begun before Codex
  // wrote them, leave earlier requests to the cumulative counter.
  let instrument: 'request' | 'counter' = 'counter';
  const namedCompactions = new Set<string>();
  for (const [lineIndex, line] of parsedLines.entries()) {
    if (!line || lineIndex < ownFrom) continue;
    if (line.type === 'compacted' && typeof line.payload.compaction_response_id === 'string') {
      namedCompactions.add(line.payload.compaction_response_id);
    }
    if (line.type !== 'token_usage_record' || instrument === 'request') continue;
    const record = asUsageRecord(line);
    if (!record || record.thread_id !== sessionId) continue;
    if (sameUsage(record.usage, record.thread)) instrument = 'request';
    else break;
  }

  // Fall back to filename for session ID
  if (!sessionId) {
    const basename = path.basename(filePath, '.jsonl');
    // Extract UUID from filename like "rollout-2026-02-18T20-10-57-019c7373-39f7..."
    const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = uuidMatch?.[1] ?? basename;
  }

  const project = projectNameFromCwd(cwd) ?? undefined;

  // Apply date filter on session start time
  if (sessionTimestamp && options?.from) {
    const ts = new Date(sessionTimestamp);
    if (ts < options.from) return events;
  }
  if (sessionTimestamp && options?.to) {
    const ts = new Date(sessionTimestamp);
    if (ts > options.to) return events;
  }

  // Second pass: extract events
  let prevTokensIn = 0;
  let prevTokensOut = 0;
  let prevCacheRead = 0;
  let eventIndex = 0;
  // The thread total of the latest record, and its gap to the counter at the
  // last token_count. A compaction is billed only when the gap grows by
  // exactly its usage, so a counter that already includes it bills it once.
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
    // Keyed by the request, not the positional index, so counter rows keep their ids.
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

    // Generate session_start from session_meta
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
          ...(boundary.kind === 'none' ? {} : { _subagent_boundary: boundary.kind }),
        },
        source: 'import',
      });
      continue;
    }

    // Codex records the model selected for each turn in the JSONL. This is the
    // authoritative source for usage attribution; config.toml is only a legacy
    // fallback for older logs that predate turn_context.
    if (line.type === 'turn_context' && typeof line.payload?.model === 'string') {
      currentModel = line.payload.model;
      currentModelSource = 'turn_context';
      continue;
    }

    if (line.type === 'token_usage_record') {
      const record = !inherited ? asUsageRecord(line) : null;
      if (!record || record.thread_id !== sessionId) continue;
      threadTotal = record.thread;
      if (instrument === 'request' && !billedResponses.has(record.response_id)) {
        billedResponses.add(record.response_id);
        pushRequest(
          { ...record, model: currentModel, model_source: currentModelSource },
          namedCompactions.has(record.response_id) ? 'compaction' : 'request',
        );
      }
      continue;
    }

    if (line.type === 'compacted') {
      // Per-request records already bill the compaction they name.
      if (inherited || instrument === 'request') continue;
      const responseId = typeof line.payload.compaction_response_id === 'string' ? line.payload.compaction_response_id : undefined;
      if (!responseId || billedResponses.has(responseId) || pendingCompactions.some(r => r.response_id === responseId)) continue;
      const record = usageRecords.get(responseId);
      if (record) pendingCompactions.push({ ...record, model: currentModel, model_source: currentModelSource });
      else compactionsUnbilled++;
      continue;
    }

    // Extract token deltas from token_count events
    if (line.type === 'event_msg' && line.payload?.type === 'token_count') {
      const usage = line.payload.info?.total_token_usage;
      if (!usage) continue;

      const totalIn = (usage.input_tokens ?? 0);
      const totalOut = (usage.output_tokens ?? 0);
      const totalCacheRead = (usage.cached_input_tokens ?? 0);

      const reset = totalIn < prevTokensIn || totalOut < prevTokensOut;
      if (reset) counterResets++;
      if (!inherited) {
        const gap = threadTotal ? subtractUsage(threadTotal, { input: totalIn, cached: totalCacheRead, output: totalOut }) : undefined;
        // After a reset the gap grows by more than any held compaction, so
        // the exact-growth check fails closed on its own.
        settleCompactions(gap);
        counterGap = gap;
      }

      // Compute deltas
      const deltaIn = totalIn - prevTokensIn;
      const deltaOut = totalOut - prevTokensOut;
      const deltaCacheRead = totalCacheRead - prevCacheRead;

      prevTokensIn = totalIn;
      prevTokensOut = totalOut;
      prevCacheRead = totalCacheRead;

      // OpenAI/Codex report input_tokens as cache-inclusive (cached_input_tokens
      // is a subset of it). Bill only the uncached remainder at the full input
      // rate; the cached portion is charged separately at the cache-read rate.
      const deltaInputUncached = Math.max(0, deltaIn - deltaCacheRead);

      // Only emit if there's a meaningful delta
      if (deltaIn <= 0 && deltaOut <= 0) continue;
      // The requests are billed from their records; the counter still takes
      // its place in the event index, so file changes keep their ids.
      if (inherited || instrument === 'request') {
        if (inherited) inheritedCountersSkipped++;
        eventIndex++;
        continue;
      }

      const eventId = crypto
        .createHash('sha256')
        .update(`codex:${sessionId}:token:${eventIndex}`)
        .digest('hex')
        .slice(0, 32);

      // Calculate cost from deltas
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

    // Extract file stats from apply_patch tool calls
    // Format 1: custom_tool_call with name=apply_patch and input=<patch>
    // Format 2: function_call with name=exec_command and arguments={"cmd":"apply_patch <<'PATCH'\n..."}
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
          // arguments might be a plain string containing apply_patch
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
            .update(`codex:${sessionId}:patch:${eventIndex}`)
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

    // Skip other event types for now
  }

  // A compaction after the last counter is checked against that counter.
  if (pendingCompactions.length > 0) {
    settleCompactions(threadTotal ? subtractUsage(threadTotal, { input: prevTokensIn, cached: prevCacheRead, output: prevTokensOut }) : undefined);
  }

  // Add session_end event
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

  // Invocation mode is a session-level constant derived from originator; stamp it
  // on every event so the session upsert persists it regardless of insert order.
  return mode ? events.map((e) => ({ ...e, mode })) : events;
}

// ─── File hash for import state tracking ────────────────────────────────

export function hashFile(filePath: string): string {
  return hashContent(fs.readFileSync(filePath));
}

export function hashContent(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
