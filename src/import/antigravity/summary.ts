import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { projectNameFromCwd } from '../../util/project-identity.js';

interface SummaryRow {
  title: string | null;
  preview: string | null;
  workspace_uris: string | null;
  parent_conversation_id: string | null;
}

export interface AntigravitySummaryMetadata {
  project: string | null;
  cwd: string | null;
  title: string | null;
  firstMessage: string | null;
  parentSessionId: string | null;
  relationshipType: 'subagent' | null;
  rawSignature: string;
}

function cleanSummaryText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

function workspacePathFromUris(raw: string | null): string | null {
  if (!raw) return null;
  let uris: unknown;
  try {
    uris = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  for (const item of uris) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('file://')) {
      try {
        return fileURLToPath(trimmed);
      } catch {
        const stripped = trimmed.slice('file://'.length);
        return stripped || null;
      }
    }
    return trimmed;
  }
  return null;
}

function findSummaryDbPath(conversationDbPath: string): string | null {
  const direct = path.join(path.dirname(path.dirname(conversationDbPath)), 'conversation_summaries.db');
  if (fs.existsSync(direct)) return direct;

  let current = path.dirname(conversationDbPath);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'conversations') {
      const candidate = path.join(path.dirname(current), 'conversation_summaries.db');
      if (fs.existsSync(candidate)) return candidate;
      break;
    }
    current = path.dirname(current);
  }
  return null;
}

export function readAntigravityConversationSummary(
  conversationDbPath: string,
  sessionId: string,
): AntigravitySummaryMetadata | null {
  const summaryDbPath = findSummaryDbPath(conversationDbPath);
  if (!summaryDbPath) return null;

  let summaryDb: Database.Database | undefined;
  try {
    summaryDb = new Database(summaryDbPath, { readonly: true, fileMustExist: true, timeout: 500 });
    const row = summaryDb.prepare(`
      SELECT title, preview, workspace_uris, parent_conversation_id
      FROM conversation_summaries
      WHERE conversation_id = ?
    `).get(sessionId) as SummaryRow | undefined;
    if (!row) return null;

    const cwd = workspacePathFromUris(row.workspace_uris);
    const project = projectNameFromCwd(cwd);
    const title = cleanSummaryText(row.title);
    const preview = cleanSummaryText(row.preview);
    const firstMessage = title ?? preview ?? null;
    const parentRaw = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '';
    const parentSessionId = parentRaw || null;
    const relationshipType = parentSessionId ? 'subagent' : null;

    return {
      project,
      cwd,
      title,
      firstMessage,
      parentSessionId,
      relationshipType,
      rawSignature: JSON.stringify([
        row.title ?? '',
        row.preview ?? '',
        row.workspace_uris ?? '',
        row.parent_conversation_id ?? '',
      ]),
    };
  } catch {
    return null;
  } finally {
    summaryDb?.close();
  }
}
