import type Database from 'better-sqlite3';
import type { ContentBlock, ParsedMessage, ParsedSession } from '../parser/claude-code.js';
import { normalizeClaudeBlock } from './normalize.js';

export interface ClaudeLiveSyncResult {
  inserted_turns: number;
  inserted_items: number;
  reset: boolean;
  live_status: string;
  last_item_at: string | null;
}

function parseMessageBlocks(message: ParsedMessage): ContentBlock[] {
  try {
    return JSON.parse(message.content) as ContentBlock[];
  } catch {
    return [{ type: 'text', text: message.content }];
  }
}

function deriveLiveStatus(lastItemAt: string | null): string {
  if (!lastItemAt) return 'available';
  const diffMs = Date.now() - new Date(lastItemAt).getTime();
  if (Number.isNaN(diffMs)) return 'available';
  if (diffMs <= 5 * 60_000) return 'live';
  if (diffMs <= 15 * 60_000) return 'active';
  return 'ended';
}

function resetLiveSession(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM session_items WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId);
}

export function syncClaudeLiveSession(
  db: Database.Database,
  parsed: ParsedSession,
): ClaudeLiveSyncResult {
  const sessionId = parsed.metadata.session_id;
  const existingTurnCount = (
    db.prepare('SELECT COUNT(*) as c FROM session_turns WHERE session_id = ?').get(sessionId) as { c: number }
  ).c;

  let reset = false;
  let startOrdinal = existingTurnCount;

  if (parsed.messages.length < existingTurnCount) {
    resetLiveSession(db, sessionId);
    reset = true;
    startOrdinal = 0;
  }

  const insertTurn = db.prepare(`
    INSERT INTO session_turns (
      session_id, agent_type, source_turn_id, status, title, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO session_items (
      session_id, turn_id, ordinal, source_item_id, kind, status, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedTurns = 0;
  let insertedItems = 0;

  for (const message of parsed.messages.slice(startOrdinal)) {
    const sourceTurnId = `claude-message:${message.ordinal}`;
    const blocks = parseMessageBlocks(message);
    const titleBlock = blocks.find(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim());
    const title = titleBlock?.text?.trim().slice(0, 120) || `${message.role} message ${message.ordinal + 1}`;

    const turnResult = insertTurn.run(
      sessionId,
      parsed.metadata.agent,
      sourceTurnId,
      'completed',
      title,
      message.timestamp,
      message.timestamp,
    );
    insertedTurns++;

    let itemOrdinal = 0;
    for (const block of blocks) {
      const normalized = normalizeClaudeBlock(
        message.role === 'user' ? 'user' : 'assistant',
        block,
        message.timestamp ?? undefined,
      );
      if (!normalized) continue;

      insertItem.run(
        sessionId,
        Number(turnResult.lastInsertRowid),
        itemOrdinal,
        normalized.source_item_id ?? `${sourceTurnId}:item:${itemOrdinal}`,
        normalized.kind,
        normalized.status ?? 'success',
        JSON.stringify(normalized.payload),
        normalized.created_at ?? message.timestamp,
      );
      insertedItems++;
      itemOrdinal++;
    }
  }

  const liveStatus = deriveLiveStatus(parsed.metadata.ended_at);
  db.prepare(`
    UPDATE browsing_sessions
    SET integration_mode = 'claude-jsonl',
        fidelity = 'full',
        last_item_at = ?,
        live_status = ?
    WHERE id = ?
  `).run(parsed.metadata.ended_at, liveStatus, sessionId);

  return {
    inserted_turns: insertedTurns,
    inserted_items: insertedItems,
    reset,
    live_status: liveStatus,
    last_item_at: parsed.metadata.ended_at,
  };
}

