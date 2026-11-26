
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import type { ContentBlock, ParsedSession, ParsedMessage } from '../parser/claude-code.js';
import { resolveContextWindow } from '../pricing/context-windows.js';
import { applyLivePrivacyPolicy, normalizeClaudeBlock } from './normalize.js';
import {
  clearProjectedSessionStream,
  FULL_PROJECTION_CAPABILITIES,
  insertProjectedItem,
  insertProjectedTurn,
  upsertProjectedSessionSnapshot,
} from './projector.js';
import type { ClaudeLiveSyncResult, LiveSyncOptions } from './claude-adapter.js';
import { liveStatusFromActivity } from './live-status.js';

const ANTIGRAVITY_SQLITE_CAPABILITIES = Object.freeze({
  history: 'summary' as const,
  search: 'summary' as const,
  tool_analytics: 'summary' as const,
  live_items: 'summary' as const,
});

function parseMessageBlocks(message: ParsedMessage): ContentBlock[] {
  try {
    return JSON.parse(message.content) as ContentBlock[];
  } catch {
    return [{ type: 'text', text: message.content }];
  }
}

interface ExistingAntigravityProjectionRow {
  project: string | null;
  title: string | null;
  first_message: string | null;
  parent_session_id: string | null;
  relationship_type: string | null;
  context_used_tokens: number | null;
  context_window_tokens: number | null;
}

export function preserveAntigravitySessionMetadata(
  db: Database.Database,
  parsed: ParsedSession,
): ParsedSession {
  const existing = db.prepare(`
    SELECT project, title, first_message, parent_session_id, relationship_type,
           context_used_tokens, context_window_tokens
    FROM browsing_sessions
    WHERE id = ?
  `).get(parsed.metadata.session_id) as ExistingAntigravityProjectionRow | undefined;
  if (!existing) return parsed;

  const metadata = { ...parsed.metadata };
  metadata.project ??= existing.project;
  if (!metadata.title && existing.title) {
    metadata.title = existing.title;
    metadata.first_message = existing.first_message ?? existing.title;
  } else if (!metadata.first_message && existing.first_message) {
    metadata.first_message = existing.first_message;
  }
  metadata.parent_session_id ??= existing.parent_session_id;
  metadata.relationship_type ??= existing.relationship_type;
  if (metadata.context_used_tokens == null && existing.context_used_tokens != null) {
    metadata.context_used_tokens = existing.context_used_tokens;
  }
  if (metadata.context_window_reported == null && existing.context_window_tokens != null) {
    metadata.context_window_reported = existing.context_window_tokens;
  }
  return { ...parsed, metadata };
}

export function syncAntigravityLiveSession(
  db: Database.Database,
  parsedInput: ParsedSession,
  options: LiveSyncOptions = {},
): ClaudeLiveSyncResult {
  const parsed = preserveAntigravitySessionMetadata(db, parsedInput);
  const sessionId = parsed.metadata.session_id;
  const existingTurnCount = (
    db.prepare('SELECT COUNT(*) as c FROM session_turns WHERE session_id = ?').get(sessionId) as { c: number }
  ).c;

  let reset = false;
  let startOrdinal = existingTurnCount;

  // WHY: A rewritten earlier step invalidates an appended projection even when some final steps
  // still match.
  if (parsed.messages.length < existingTurnCount
    || (options.keptMessages !== undefined && options.keptMessages < existingTurnCount)) {
    clearProjectedSessionStream(db, sessionId);
    reset = true;
    startOrdinal = 0;
  }

  let insertedTurns = 0;
  let insertedItems = 0;
  const privacyPolicy = options.privacyPolicy ?? {
    capturePrompts: config.live.capture.prompts,
    captureReasoning: config.live.capture.reasoning,
    captureToolArguments: config.live.capture.toolArguments,
    diffPayloadMaxBytes: config.live.diffPayloadMaxBytes,
  };

  for (const message of parsed.messages.slice(startOrdinal)) {
    const sourceTurnId = `antigravity-message:${message.ordinal}`;
    const blocks = parseMessageBlocks(message);
    const titleBlock = blocks.find(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim());
    const title = titleBlock?.text?.trim().slice(0, 120) || `${message.role} message ${message.ordinal + 1}`;

    const turnId = insertProjectedTurn(db, sessionId, {
      agent_type: 'antigravity',
      source_turn_id: sourceTurnId,
      status: 'completed',
      title,
      started_at: message.timestamp,
      ended_at: message.timestamp,
    });
    insertedTurns++;

    let itemOrdinal = 0;
    for (const block of blocks) {
      const normalizedItem = normalizeClaudeBlock(
        message.role === 'user' ? 'user' : 'assistant',
        block,
        block.timestamp ?? message.timestamp ?? undefined,
      );
      if (!normalizedItem) continue;
      if (message.role === 'system' && normalizedItem.kind === 'assistant_message') {
        normalizedItem.kind = 'instructions';
      }
      const normalized = applyLivePrivacyPolicy(normalizedItem, privacyPolicy);

      insertProjectedItem(db, sessionId, turnId, {
        ordinal: itemOrdinal,
        source_item_id: normalized.source_item_id ?? `${sourceTurnId}:item:${itemOrdinal}`,
        kind: normalized.kind,
        status: normalized.status ?? 'success',
        payload: normalized.payload,
        created_at: normalized.created_at ?? message.timestamp,
      });
      insertedItems++;
      itemOrdinal++;
    }
  }

  const liveStatus = liveStatusFromActivity(parsed.metadata.ended_at);
  const usedTokens = parsed.metadata.context_used_tokens ?? null;
  const contextWindow = usedTokens != null
    ? resolveContextWindow({
        agent: 'antigravity',
        model: parsed.metadata.model,
        reportedWindow: parsed.metadata.context_window_reported,
        observedTokens: usedTokens,
      })
    : null;
  const isFull = parsed.metadata.fidelity === 'full';
  upsertProjectedSessionSnapshot(db, {
    id: sessionId,
    agent: 'antigravity',
    project: parsed.metadata.project,
    first_message: parsed.metadata.first_message,
    title: parsed.metadata.title ?? null,
    started_at: parsed.metadata.started_at,
    ended_at: parsed.metadata.ended_at,
    message_count: parsed.metadata.message_count,
    user_message_count: parsed.metadata.user_message_count,
    parent_session_id: parsed.metadata.parent_session_id,
    relationship_type: parsed.metadata.relationship_type,
    live_status: liveStatus,
    last_item_at: parsed.metadata.ended_at,
    context_used_tokens: usedTokens,
    context_window_tokens: contextWindow,
  }, isFull ? {
    integration_mode: 'antigravity-transcript',
    fidelity: 'full',
    capabilities: FULL_PROJECTION_CAPABILITIES,
  } : {
    integration_mode: 'antigravity-sqlite',
    fidelity: 'summary',
    capabilities: ANTIGRAVITY_SQLITE_CAPABILITIES,
  });

  return {
    inserted_turns: insertedTurns,
    inserted_items: insertedItems,
    reset,
    live_status: liveStatus,
    last_item_at: parsed.metadata.ended_at,
  };
}
