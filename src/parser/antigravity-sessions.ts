import path from 'node:path';
import Database from 'better-sqlite3';
import type { ContentBlock, ParsedSession, ParsedMessage, ParsedToolCall } from './claude-code.js';
import { stepKindToEvent } from '../import/antigravity.js';
import { decodeGeneratorMetadata, decodeStepEnvelope, decodeStepTimestampMs } from '../import/antigravity/proto.js';
import { readAntigravityConversationSummary } from '../import/antigravity/summary.js';
import { projectIdentityFromCwd, unavailableSkillContext } from '../skills/context-observations.js';
import { parseAntigravityTranscript, resolveAntigravityTranscriptPath } from './antigravity-transcript.js';

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
          const promptTokens = gm.usage.systemPromptTokens + gm.usage.inputTokens + gm.usage.cachedTokens;
          if (promptTokens > 0) contextUsedTokens = promptTokens;
        }
      }
    }

    const summary = readAntigravityConversationSummary(filePath, sessionId);
    const skillContext = unavailableSkillContext();
    if (summary?.cwd) {
      skillContext.projectIdentity = projectIdentityFromCwd(summary.cwd);
    }

    const transcript = parseAntigravityTranscript(
      resolveAntigravityTranscriptPath(filePath, sessionId),
      sessionId,
    );
    if (transcript) {
      return {
        messages: transcript.messages,
        toolCalls: transcript.toolCalls,
        metadata: {
          session_id: sessionId,
          project: summary?.project ?? null,
          agent: 'antigravity',
          first_message: summary?.firstMessage ?? transcript.firstUserMessage,
          cwd: summary?.cwd ?? null,
          title: summary?.title ?? null,
          started_at: transcript.startedAt,
          ended_at: transcript.endedAt,
          message_count: transcript.messages.length,
          user_message_count: transcript.userMessageCount,
          parent_session_id: summary?.parentSessionId ?? null,
          relationship_type: summary?.relationshipType ?? null,
          context_used_tokens: contextUsedTokens ?? transcript.contextUsedTokens,
          model: latestModel ?? transcript.latestModel,
          fidelity: 'full',
        },
        skillContext,
      };
    }

    if (!db) return emptySession(sessionId);

    const steps = safeAll<StepRow>(db, 'SELECT idx, step_type, status, step_payload, metadata FROM steps ORDER BY idx');
    if (steps.length === 0) return emptySession(sessionId);

    const stepTs = steps.map((s) => (s.metadata ? decodeStepTimestampMs(s.metadata) : undefined));
    const times = stepTs.filter((t): t is number => t !== undefined);
    const startedAt = iso(times.length ? Math.min(...times) : undefined);
    const endedAt = iso(times.length ? Math.max(...times) : undefined);

    const messages: ParsedMessage[] = [];
    const toolCalls: ParsedToolCall[] = [];
    let firstUserMessage: string | null = null;
    let userMessageCount = 0;

    steps.forEach((s, i) => {
      const env = decodeStepEnvelope(s.step_payload);
      const { type, toolName } = stepKindToEvent(env.kind);
      const role = type === 'user_prompt' ? 'user' : 'assistant';
      const timestamp = iso(stepTs[i]);

      let blocks: ContentBlock[];
      let hasToolUse = 0;
      if (type === 'tool_use') {
        const name = toolName ?? env.kind ?? 'tool';
        blocks = [{ type: 'tool_use', name, input: null }];
        hasToolUse = 1;
        toolCalls.push({
          session_id: sessionId,
          tool_name: name,
          category: 'Other',
          tool_use_id: null,
          input_json: null,
          subagent_session_id: null,
          message_ordinal: messages.length,
        });
      } else {
        blocks = [{ type: 'text', text: stepLabel(env.kind) }];
      }

      if (role === 'user') {
        userMessageCount++;
        if (firstUserMessage === null) firstUserMessage = stepLabel(env.kind);
      }

      const content = JSON.stringify(blocks);
      messages.push({
        session_id: sessionId,
        ordinal: messages.length,
        role,
        content,
        timestamp,
        has_thinking: 0,
        has_tool_use: hasToolUse,
        content_length: content.length,
      });
    });

    return {
      messages,
      toolCalls,
      metadata: {
        session_id: sessionId,
        project: summary?.project ?? null,
        agent: 'antigravity',
        first_message: summary?.firstMessage ?? firstUserMessage,
        cwd: summary?.cwd ?? null,
        title: summary?.title ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        message_count: messages.length,
        user_message_count: userMessageCount,
        parent_session_id: summary?.parentSessionId ?? null,
        relationship_type: summary?.relationshipType ?? null,
        context_used_tokens: contextUsedTokens,
        model: latestModel,
        fidelity: 'summary',
      },
      skillContext,
    };
  } finally {
    db?.close();
  }
}
