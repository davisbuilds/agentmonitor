import path from 'node:path';
import Database from 'better-sqlite3';
import type { ContentBlock, ParsedSession, ParsedMessage, ParsedToolCall } from './claude-code.js';
import { stepKindToEvent } from '../import/antigravity.js';
import { decodeGeneratorMetadata, decodeStepEnvelope, decodeStepTimestampMs, deriveBillingTokens } from '../import/antigravity/proto.js';
import { readAntigravityConversationSummary } from '../import/antigravity/summary.js';
import { projectIdentityFromCwd, unavailableSkillContext } from '../skills/context-observations.js';
import {
  parseAntigravityTranscript,
  resolveAntigravityTranscriptPaths,
  type AntigravityTranscriptResult,
} from './antigravity-transcript.js';

interface StepRow { idx: number; step_type: number; status: number; step_payload: Buffer; metadata: Buffer | null }
interface GenRow { idx: number; data: Buffer }

function safeAll<T>(db: Database.Database, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** Human-readable summary label for a step whose payload internals are opaque. */
function stepLabel(kind: string | undefined): string {
  return kind ? kind.replace(/_/g, ' ') : 'activity';
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function stepRowToSummaryEntry(
  sessionId: string,
  step: StepRow,
  ordinal: number,
  tsMs: number | undefined,
): {
  message: ParsedMessage;
  toolCall: ParsedToolCall | null;
  isUser: boolean;
  label: string;
} {
  const env = decodeStepEnvelope(step.step_payload);
  const { type, toolName } = stepKindToEvent(env.kind);
  const role = type === 'user_prompt' ? 'user' : 'assistant';
  const timestamp = iso(tsMs);
  const label = stepLabel(env.kind);

  let blocks: ContentBlock[];
  let hasToolUse = 0;
  let toolCall: ParsedToolCall | null = null;
  if (type === 'tool_use') {
    const name = toolName ?? env.kind ?? 'tool';
    blocks = [{ type: 'tool_use', name, input: null }];
    hasToolUse = 1;
    toolCall = {
      session_id: sessionId,
      tool_name: name,
      category: 'Other',
      tool_use_id: null,
      input_json: null,
      subagent_session_id: null,
      message_ordinal: ordinal,
    };
  } else {
    blocks = [{ type: 'text', text: label }];
  }

  const content = JSON.stringify(blocks);
  return {
    message: {
      session_id: sessionId,
      ordinal,
      role,
      content,
      timestamp,
      has_thinking: 0,
      has_tool_use: hasToolUse,
      content_length: content.length,
    },
    toolCall,
    isUser: role === 'user',
    label,
  };
}

function appendStepSummaryRows(
  sessionId: string,
  steps: readonly StepRow[],
  messages: ParsedMessage[],
  toolCalls: ParsedToolCall[],
  initialUserMessage: string | null,
  initialUserCount: number,
): {
  firstUserMessage: string | null;
  userMessageCount: number;
  sqliteStartedAt: string | null;
  sqliteEndedAt: string | null;
} {
  const stepTs = steps.map((s) => (s.metadata ? decodeStepTimestampMs(s.metadata) : undefined));
  const times = stepTs.filter((t): t is number => t !== undefined);
  const sqliteStartedAt = iso(times.length ? Math.min(...times) : undefined);
  const sqliteEndedAt = iso(times.length ? Math.max(...times) : undefined);

  let firstUserMessage = initialUserMessage;
  let userMessageCount = initialUserCount;

  steps.forEach((step, idx) => {
    const entry = stepRowToSummaryEntry(sessionId, step, messages.length, stepTs[idx]);
    messages.push(entry.message);
    if (entry.toolCall) toolCalls.push(entry.toolCall);
    if (entry.isUser) {
      userMessageCount++;
      firstUserMessage ??= entry.label;
    }
  });

  return { firstUserMessage, userMessageCount, sqliteStartedAt, sqliteEndedAt };
}

function loadPreferredTranscript(filePath: string, sessionId: string): AntigravityTranscriptResult | null {
  const { fullPath, compactPath } = resolveAntigravityTranscriptPaths(filePath, sessionId);
  return parseAntigravityTranscript(fullPath, sessionId)
    ?? parseAntigravityTranscript(compactPath, sessionId);
}

function emptySession(sessionId: string): ParsedSession {
  return {
    messages: [],
    toolCalls: [],
    metadata: {
      session_id: sessionId,
      project: null,
      agent: 'antigravity',
      first_message: null,
      started_at: null,
      ended_at: null,
      message_count: 0,
      user_message_count: 0,
      parent_session_id: null,
      relationship_type: null,
      integration_mode: 'antigravity-sqlite',
      fidelity: 'summary',
    },
    skillContext: unavailableSkillContext(),
  };
}

export function parseAntigravitySessions(filePath: string): ParsedSession {
  const sessionId = path.basename(filePath, '.db');

  let db: Database.Database | undefined;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    db = undefined;
  }

  try {
    let latestModel: string | undefined;
    let contextUsedTokens: number | undefined;
    if (db) {
      const genRows = safeAll<GenRow>(db, 'SELECT idx, data FROM gen_metadata ORDER BY idx');
      for (const row of genRows) {
        const gm = decodeGeneratorMetadata(row.data);
        if (gm.model) latestModel = gm.model;
        if (gm.usage) {
          const b = deriveBillingTokens(gm.usage);
          const promptTokens = b.tokensIn + b.cacheReadTokens + b.cacheWriteTokens;
          if (promptTokens > 0) contextUsedTokens = promptTokens;
        }
      }
    }

    const summary = readAntigravityConversationSummary(filePath, sessionId);
    const skillContext = unavailableSkillContext();
    if (summary?.cwd) {
      skillContext.projectIdentity = projectIdentityFromCwd(summary.cwd);
    }

    const steps = db
      ? safeAll<StepRow>(db, 'SELECT idx, step_type, status, step_payload, metadata FROM steps ORDER BY idx')
      : [];

    const transcript = loadPreferredTranscript(filePath, sessionId);
    if (transcript) {
      const messages = [...transcript.messages];
      const toolCalls = [...transcript.toolCalls];
      const trailingSteps = transcript.maxStepIndex !== null
        ? steps.filter(step => step.idx > transcript.maxStepIndex!)
        : [];
      const merged = appendStepSummaryRows(
        sessionId,
        trailingSteps,
        messages,
        toolCalls,
        transcript.firstUserMessage,
        transcript.userMessageCount,
      );
      const fallbackStepTimes = !transcript.startedAt || !transcript.endedAt
        ? steps
            .map((s) => (s.metadata ? decodeStepTimestampMs(s.metadata) : undefined))
            .filter((t): t is number => t !== undefined)
        : [];
      const fallbackStart = iso(fallbackStepTimes.length ? Math.min(...fallbackStepTimes) : undefined);
      const fallbackEnd = iso(fallbackStepTimes.length ? Math.max(...fallbackStepTimes) : undefined);

      return {
        messages,
        toolCalls,
        metadata: {
          session_id: sessionId,
          project: summary?.project ?? null,
          agent: 'antigravity',
          first_message: summary?.firstMessage ?? merged.firstUserMessage,
          cwd: summary?.cwd ?? null,
          title: summary?.title ?? null,
          started_at: transcript.startedAt ?? fallbackStart,
          ended_at: maxIso(transcript.endedAt ?? fallbackEnd, merged.sqliteEndedAt),
          message_count: messages.length,
          user_message_count: merged.userMessageCount,
          parent_session_id: summary?.parentSessionId ?? null,
          relationship_type: summary?.relationshipType ?? null,
          context_used_tokens: contextUsedTokens ?? transcript.contextUsedTokens,
          model: latestModel ?? transcript.latestModel,
          integration_mode: 'antigravity-transcript',
          fidelity: transcript.hasTruncatedFields ? 'summary' : 'full',
        },
        skillContext,
      };
    }

    if (steps.length === 0) return emptySession(sessionId);

    const messages: ParsedMessage[] = [];
    const toolCalls: ParsedToolCall[] = [];
    const summarySteps = appendStepSummaryRows(sessionId, steps, messages, toolCalls, null, 0);

    return {
      messages,
      toolCalls,
      metadata: {
        session_id: sessionId,
        project: summary?.project ?? null,
        agent: 'antigravity',
        first_message: summary?.firstMessage ?? summarySteps.firstUserMessage,
        cwd: summary?.cwd ?? null,
        title: summary?.title ?? null,
        started_at: summarySteps.sqliteStartedAt,
        ended_at: summarySteps.sqliteEndedAt,
        message_count: messages.length,
        user_message_count: summarySteps.userMessageCount,
        parent_session_id: summary?.parentSessionId ?? null,
        relationship_type: summary?.relationshipType ?? null,
        context_used_tokens: contextUsedTokens,
        model: latestModel,
        integration_mode: 'antigravity-sqlite',
        fidelity: 'summary',
      },
      skillContext,
    };
  } finally {
    db?.close();
  }
}
