import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import type { EventType } from '../contracts/event-contract.js';
import { insertEvent, markStatsDirty, resolveEventGitBranch, type EventRow } from '../db/queries.js';
import { pricingRegistry } from '../pricing/index.js';
import { discoverDbFilesRecursive } from '../util/file-discovery.js';
import type { ParsedImportEvent } from './claude-code.js';
import { deriveBillingTokens } from './antigravity/proto.js';
import {
  hashAntigravityConversation,
  readAntigravityConversationSnapshot,
  type AntigravityConversationSnapshot,
  type AntigravitySnapshotOptions,
} from './antigravity/snapshot.js';

const AGENT_TYPE = 'antigravity';

function antigravityHome(dir?: string): string {
  return dir ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

export function discoverAntigravityLogs(
  dir?: string,
  options?: { excludePatterns?: string[] },
): string[] {
  const root = path.join(antigravityHome(dir), 'conversations');
  return discoverDbFilesRecursive(root, { excludePatterns: options?.excludePatterns });
}

export function hashFile(filePath: string): string {
  return hashAntigravityConversation(filePath);
}

const USER_PROMPT_KINDS = new Set(['user_input', 'plan_input', 'ask_question']);
const RESPONSE_KINDS = new Set([
  'planner_response', 'suggested_responses', 'notify_user', 'ephemeral_message',
  'system_message', 'conversation_history', 'critique', 'findings',
  'proposal_feedback', 'manager_feedback', 'code_acknowledgement', 'directory_rules',
]);
const FILE_CHANGE_KINDS = new Set([
  'write_to_file', 'file_change', 'code_action', 'propose_code', 'edit_notebook',
  'write_blob', 'move', 'delete_directory',
]);
const TOOL_KIND_PREFIXES = ['browser_', 'mcp_', 'cloudsql_', 'blaze_', 'capture_'];
const TOOL_KINDS = new Set([
  'run_command', 'command_status', 'send_command_input', 'shell_exec', 'grep_search',
  'code_search', 'internal_search', 'search_web', 'search_knowledge_base',
  'lookup_knowledge_base', 'trajectory_search', 'find', 'find_all_references',
  'view_file', 'view_file_outline', 'view_code_item', 'view_content_chunk',
  'list_directory', 'list_resources', 'read_resource', 'read_url_content',
  'read_terminal', 'read_notebook', 'execute_notebook', 'run_extension_code',
  'lint_diff', 'lint_applet', 'compile', 'compile_applet',
  'install_applet_dependencies', 'install_applet_package', 'restart_dev_server',
  'generate_image', 'open_browser_url', 'set_up_firebase', 'deploy_firebase',
  'set_up_cloudsql', 'mcp_tool', 'agency_tool_call', 'invoke_subagent',
  'rpc_action', 'workspace_api', 'retrieve_memory', 'retrieve_content', 'tool_search',
]);

export function stepKindToEvent(kind: string | undefined): { type: EventType; toolName?: string } {
  if (!kind) return { type: 'response' };
  if (USER_PROMPT_KINDS.has(kind)) return { type: 'user_prompt' };
  if (kind === 'finish') return { type: 'session_end' };
  if (kind === 'error_message') return { type: 'error' };
  if (kind === 'git_commit') return { type: 'git_commit', toolName: 'git_commit' };
  if (kind === 'checkpoint') return { type: 'plan_step' };
  if (FILE_CHANGE_KINDS.has(kind)) return { type: 'file_change', toolName: kind };
  if (RESPONSE_KINDS.has(kind)) return { type: 'response' };
  if (TOOL_KINDS.has(kind) || TOOL_KIND_PREFIXES.some((p) => kind.startsWith(p))) {
    return { type: 'tool_use', toolName: kind };
  }
  return { type: 'response' };
}

function eventId(sessionId: string, tag: string): string {
  const h = crypto.createHash('sha256').update(`antigravity:${sessionId}:${tag}`).digest('hex').slice(0, 32);
  return `import-agr-${h}`;
}

const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

export function antigravitySnapshotToEvents(
  snapshot: AntigravityConversationSnapshot,
  options?: { from?: Date; to?: Date },
): ParsedImportEvent[] {
  const events: ParsedImportEvent[] = [];
  const { sessionId, steps, generations, summary } = snapshot;
  if (steps.length === 0 && generations.length === 0) return events;

  const firstTs = steps.find((s) => s.timestampMs !== undefined)?.timestampMs;
  const sessionModel = generations.find((g) => g.decoded.model)?.decoded.model;
  const summaryProject = summary?.project ?? undefined;

  if (firstTs !== undefined) {
    if (options?.from && firstTs < options.from.getTime()) return events;
    if (options?.to && firstTs > options.to.getTime()) return events;
  }

  events.push({
    event_id: eventId(sessionId, 'session_start'),
    session_id: sessionId,
    agent_type: AGENT_TYPE,
    event_type: 'session_start',
    status: 'success',
    tokens_in: 0,
    tokens_out: 0,
    model: sessionModel,
    project: summaryProject,
    client_timestamp: iso(firstTs),
    metadata: { _source: 'antigravity_db' },
    source: 'import',
  });

  for (const step of steps) {
    const { type, toolName } = stepKindToEvent(step.envelope.kind);
    events.push({
      event_id: eventId(sessionId, `step:${step.idx}`),
      session_id: sessionId,
      agent_type: AGENT_TYPE,
      event_type: type,
      tool_name: toolName,
      status: type === 'error' ? 'error' : 'success',
      tokens_in: 0,
      tokens_out: 0,
      model: sessionModel,
      project: summaryProject,
      client_timestamp: iso(step.timestampMs),
      metadata: { _source: 'antigravity_db', kind: step.envelope.kind ?? null, step_type: step.step_type },
      source: 'import',
    });
  }

  const msgIdCounts = new Map<string, number>();
  const pmsgIdCounts = new Map<string, number>();
  for (const gen of generations) {
    if (gen.decoded.messageId) {
      msgIdCounts.set(gen.decoded.messageId, (msgIdCounts.get(gen.decoded.messageId) ?? 0) + 1);
    }
    if (gen.decoded.providerAssignedMessageId) {
      pmsgIdCounts.set(
        gen.decoded.providerAssignedMessageId,
        (pmsgIdCounts.get(gen.decoded.providerAssignedMessageId) ?? 0) + 1,
      );
    }
  }

  generations.forEach((gen, i) => {
    const gm = gen.decoded;
    if (!gm.usage) return;
    const b = deriveBillingTokens(gm.usage);
    const model = gm.model ?? sessionModel;
    // WHY: Each generation can cross a pricing boundary even within one session; unattributed
    // generations keep client_timestamp undefined so they stay out of dated windows.
    const at = iso(gen.timestampMs);
    const cost = model
      ? pricingRegistry.calculate(
          model,
          {
            input: b.tokensIn,
            output: b.tokensOut,
            cacheRead: b.cacheReadTokens,
            cacheWrite: b.cacheWriteTokens,
          },
          at,
        )
      : null;

    let stableTag: string;
    if (gm.messageId && msgIdCounts.get(gm.messageId) === 1) {
      stableTag = `gen:msg:${gm.messageId}`;
    } else if (gm.providerAssignedMessageId && pmsgIdCounts.get(gm.providerAssignedMessageId) === 1) {
      stableTag = `gen:pmsg:${gm.providerAssignedMessageId}`;
    } else {
      stableTag = `gen:idx:${gen.idx}`;
    }

    events.push({
      event_id: eventId(sessionId, stableTag),
      legacy_event_id: eventId(sessionId, `gen:${i}`),
      session_id: sessionId,
      agent_type: AGENT_TYPE,
      event_type: 'llm_response',
      status: 'success',
      tokens_in: b.tokensIn,
      tokens_out: b.tokensOut,
      cache_read_tokens: b.cacheReadTokens,
      cache_write_tokens: b.cacheWriteTokens,
      model,
      project: summaryProject,
      cost_usd: cost ?? undefined,
      cost_source: cost != null ? 'estimated' : undefined,
      client_timestamp: at,
      metadata: {
        _source: 'antigravity_db',
        thoughts_tokens: b.thoughtsTokens,
        timestamp_source: gen.timestampSource,
      },
      source: 'import',
    });
  });

  return events;
}

export function parseAntigravityFile(
  filePath: string,
  options?: { from?: Date; to?: Date } & AntigravitySnapshotOptions,
): ParsedImportEvent[] {
  const snapshot = readAntigravityConversationSnapshot(filePath, {
    includeTranscript: false,
    includeSummary: true,
    retryDelaysMs: options?.retryDelaysMs,
    busyTimeoutMs: options?.busyTimeoutMs,
    throwOnError: options?.throwOnError ?? true,
  });
  return antigravitySnapshotToEvents(snapshot, options);
}

export interface AntigravityIngestOptions {
  from?: Date;
  to?: Date;
  dryRun?: boolean;
  nowMs?: number;
  importStateHash?: string;
}

export interface AntigravityIngestResult {
  eventsFound: number;
  eventsImported: number;
  eventsRefreshed: number;
  duplicates: number;
  ingestedEvents: EventRow[];
  sessionStatus: 'active' | 'idle' | 'ended';
}

interface ExistingAntigravityRow {
  id: number;
  event_id: string;
  project: string | null;
  client_timestamp: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model: string | null;
  cost_usd: number | null;
  cost_source: string | null;
}

function targetAntigravitySessionStatus(
  latestActivityIso: string | null,
  existingStatus: string | undefined,
  nowMs: number,
): 'active' | 'idle' | 'ended' {
  const timeoutMinutes = Math.max(1, config.sessionTimeoutMinutes);
  const activeWindowMs = timeoutMinutes * 60_000;
  const idleWindowMs = timeoutMinutes * 2 * 60_000;
  const latestMs = latestActivityIso ? Date.parse(latestActivityIso) : Number.NaN;
  if (Number.isFinite(latestMs) && (nowMs - latestMs) <= activeWindowMs) {
    return 'active';
  }
  if (existingStatus === 'idle' && Number.isFinite(latestMs) && (nowMs - latestMs) <= idleWindowMs) {
    return 'idle';
  }
  return 'ended';
}

export function reconcileAntigravitySessionLifecycle(
  db: Database.Database,
  snapshot: AntigravityConversationSnapshot,
  options: { nowMs?: number; branch?: string | null } = {},
): 'active' | 'idle' | 'ended' {
  const existingSession = db.prepare(
    'SELECT status, project, branch FROM sessions WHERE id = ?',
  ).get(snapshot.sessionId) as { status: string; project: string | null; branch: string | null } | undefined;

  const hasNonImport = db.prepare(
    "SELECT 1 FROM events WHERE session_id = ? AND (source IS NULL OR source != 'import') LIMIT 1",
  ).get(snapshot.sessionId) !== undefined;

  const nowMs = options.nowMs ?? Date.now();
  const desiredStatus = targetAntigravitySessionStatus(snapshot.latestActivityIso, existingSession?.status, nowMs);
  if (!existingSession) return desiredStatus;

  const startedAtIso = snapshot.startedAtIso ?? snapshot.latestActivityIso ?? new Date(nowMs).toISOString();
  const latestAtIso = snapshot.latestActivityIso ?? snapshot.startedAtIso ?? new Date(nowMs).toISOString();
  const summaryProject = snapshot.summary?.project ?? null;
  const timeoutMinutes = Math.max(1, config.sessionTimeoutMinutes);

  if (!hasNonImport) {
    db.prepare(`
      UPDATE sessions
      SET status = @status,
          ended_at = CASE WHEN @status = 'ended' THEN datetime(@latestAt) ELSE NULL END,
          started_at = datetime(@startedAt),
          last_event_at = datetime(@latestAt),
          project = COALESCE(@project, project),
          branch = COALESCE(@branch, branch)
      WHERE id = @id
    `).run({
      id: snapshot.sessionId,
      status: desiredStatus,
      startedAt: startedAtIso,
      latestAt: latestAtIso,
      project: summaryProject,
      branch: options.branch ?? null,
    });
    return desiredStatus;
  }

  db.prepare(`
    UPDATE sessions
    SET started_at = MIN(started_at, datetime(@startedAt)),
        last_event_at = MAX(last_event_at, datetime(@latestAt)),
        status = CASE
          WHEN @status = 'active' THEN 'active'
          WHEN MAX(last_event_at, datetime(@latestAt)) >= datetime(@activeCutoff) THEN CASE WHEN status = 'ended' THEN 'active' ELSE status END
          ELSE @status
        END,
        ended_at = CASE
          WHEN @status = 'active' OR MAX(last_event_at, datetime(@latestAt)) >= datetime(@activeCutoff) THEN NULL
          ELSE COALESCE(ended_at, datetime(@latestAt))
        END,
        project = COALESCE(@project, project),
        branch = COALESCE(@branch, branch)
    WHERE id = @id
  `).run({
    id: snapshot.sessionId,
    status: desiredStatus,
    startedAt: startedAtIso,
    latestAt: latestAtIso,
    activeCutoff: new Date(nowMs - timeoutMinutes * 60_000).toISOString(),
    project: summaryProject,
    branch: options.branch ?? null,
  });

  const updated = db.prepare('SELECT status FROM sessions WHERE id = ?').get(snapshot.sessionId) as { status: string } | undefined;
  return updated?.status === 'active' || updated?.status === 'idle' ? updated.status : 'ended';
}

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function upsertAntigravityImportState(
  db: Database.Database,
  filePath: string,
  fileHash: string,
  eventsImported: number,
): void {
  db.prepare(`
    INSERT INTO import_state (file_path, file_hash, file_size, file_mtime, source, events_imported, imported_at)
    VALUES (?, ?, ?, NULL, 'antigravity', ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      events_imported = excluded.events_imported,
      imported_at = datetime('now')
  `).run(filePath, fileHash, safeFileSize(filePath), eventsImported);
}

export function ingestAntigravitySnapshot(
  db: Database.Database,
  snapshot: AntigravityConversationSnapshot,
  options: AntigravityIngestOptions = {},
): AntigravityIngestResult {
  const events = antigravitySnapshotToEvents(snapshot, { from: options.from, to: options.to });
  const nowMs = options.nowMs ?? Date.now();
  const isDateScoped = options.from !== undefined || options.to !== undefined;

  if (options.dryRun) {
    return {
      eventsFound: events.length,
      eventsImported: events.length,
      eventsRefreshed: 0,
      duplicates: 0,
      ingestedEvents: [],
      sessionStatus: targetAntigravitySessionStatus(snapshot.latestActivityIso, undefined, nowMs),
    };
  }

  const existingSession = db.prepare(
    'SELECT status, project FROM sessions WHERE id = ?',
  ).get(snapshot.sessionId) as { status: string; project: string | null } | undefined;

  const summaryProject = snapshot.summary?.project ?? existingSession?.project ?? undefined;
  const preliminaryStatus = targetAntigravitySessionStatus(snapshot.latestActivityIso, existingSession?.status, nowMs);
  const gitBranch = summaryProject && preliminaryStatus === 'active'
    ? resolveEventGitBranch({
        project: summaryProject,
        source: 'import',
        client_timestamp: snapshot.latestActivityIso ?? undefined,
      })
    : null;

  let eventsImported = 0;
  let eventsRefreshed = 0;
  let duplicates = 0;
  const ingestedEvents: EventRow[] = [];
  let sessionStatus: 'active' | 'idle' | 'ended' = preliminaryStatus;

  const txn = db.transaction(() => {
    const existingRows = db.prepare(`
      SELECT id, event_id, project, client_timestamp, tokens_in, tokens_out,
             cache_read_tokens, cache_write_tokens, model, cost_usd, cost_source
      FROM events
      WHERE session_id = ? AND source = 'import' AND agent_type = 'antigravity' AND event_id IS NOT NULL
    `).all(snapshot.sessionId) as ExistingAntigravityRow[];
    const existingById = new Map(existingRows.map((row) => [row.event_id, row]));

    const updateProject = db.prepare('UPDATE events SET project = ? WHERE id = ?');
    const updateLateAttributedGen = db.prepare(`
      UPDATE events
      SET client_timestamp = ?, model = ?, cost_usd = ?, cost_source = ?, metadata = ?
      WHERE id = ?
    `);

    for (const event of events) {
      const existing = event.event_id ? existingById.get(event.event_id) : undefined;
      if (existing) {
        if (existing.project == null && event.project != null) {
          updateProject.run(event.project, existing.id);
          eventsRefreshed++;
        }
        if (
          event.event_type === 'llm_response'
          && existing.client_timestamp == null
          && event.client_timestamp != null
        ) {
          updateLateAttributedGen.run(
            event.client_timestamp,
            event.model ?? existing.model,
            event.cost_usd ?? null,
            event.cost_source ?? null,
            JSON.stringify(event.metadata ?? {}),
            existing.id,
          );
          eventsRefreshed++;
        }
        duplicates++;
        continue;
      }

      if (event.legacy_event_id && existingById.has(event.legacy_event_id)) {
        duplicates++;
        continue;
      }

      const inserted = insertEvent(event, { gitBranch });
      if (inserted) {
        ingestedEvents.push(inserted);
        eventsImported++;
      } else {
        duplicates++;
      }
    }

    if (!isDateScoped && events.length > 0) {
      sessionStatus = reconcileAntigravitySessionLifecycle(db, snapshot, { nowMs, branch: gitBranch });
    }

    if (options.importStateHash !== undefined && !isDateScoped) {
      upsertAntigravityImportState(db, snapshot.filePath, options.importStateHash, eventsImported);
    }
  });

  txn();

  if (eventsImported > 0 || eventsRefreshed > 0) {
    markStatsDirty();
  }

  return {
    eventsFound: events.length,
    eventsImported,
    eventsRefreshed,
    duplicates,
    ingestedEvents,
    sessionStatus,
  };
}
