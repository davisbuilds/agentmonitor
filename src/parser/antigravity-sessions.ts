import { stepKindToEvent } from '../import/antigravity.js';
import { deriveBillingTokens } from '../import/antigravity/proto.js';
import {
  readAntigravityConversationSnapshot,
  type AntigravityConversationSnapshot,
  type AntigravitySnapshotOptions,
  type AntigravityStepRecord,
} from '../import/antigravity/snapshot.js';
import { projectIdentityFromCwd, unavailableSkillContext } from '../skills/context-observations.js';
import type { ContentBlock, ParsedMessage, ParsedSession, ParsedToolCall } from './claude-code.js';

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

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
  step: AntigravityStepRecord,
  ordinal: number,
): {
  message: ParsedMessage;
  toolCall: ParsedToolCall | null;
  isUser: boolean;
  label: string;
} {
  const { type, toolName } = stepKindToEvent(step.envelope.kind);
  const role = type === 'user_prompt' ? 'user' : 'assistant';
  const timestamp = iso(step.timestampMs);
  const label = stepLabel(step.envelope.kind);

  let blocks: ContentBlock[];
  let hasToolUse = 0;
  let toolCall: ParsedToolCall | null = null;
  if (type === 'tool_use') {
    const name = toolName ?? step.envelope.kind ?? 'tool';
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
  steps: readonly AntigravityStepRecord[],
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
  const times = steps.map((s) => s.timestampMs).filter((t): t is number => t !== undefined);
  const sqliteStartedAt = iso(times.length ? Math.min(...times) : undefined);
  const sqliteEndedAt = iso(times.length ? Math.max(...times) : undefined);

  let firstUserMessage = initialUserMessage;
  let userMessageCount = initialUserCount;

  for (const step of steps) {
    const entry = stepRowToSummaryEntry(sessionId, step, messages.length);
    messages.push(entry.message);
    if (entry.toolCall) toolCalls.push(entry.toolCall);
    if (entry.isUser) {
      userMessageCount++;
      firstUserMessage ??= entry.label;
    }
  }

  return { firstUserMessage, userMessageCount, sqliteStartedAt, sqliteEndedAt };
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

export function antigravitySnapshotToParsedSession(snapshot: AntigravityConversationSnapshot): ParsedSession {
  const { sessionId, steps, generations, summary, transcript } = snapshot;

  let latestModel: string | undefined;
  let contextUsedTokens: number | undefined;
  for (const gen of generations) {
    const gm = gen.decoded;
    if (gm.model) latestModel = gm.model;
    if (gm.usage) {
      const b = deriveBillingTokens(gm.usage);
      const promptTokens = b.tokensIn + b.cacheReadTokens + b.cacheWriteTokens;
      if (promptTokens > 0) contextUsedTokens = promptTokens;
    }
  }

  const skillContext = unavailableSkillContext();
  if (summary?.cwd) {
    skillContext.projectIdentity = projectIdentityFromCwd(summary.cwd);
  }

  if (transcript) {
    const messages = [...transcript.messages];
    const toolCalls = [...transcript.toolCalls];
    const trailingSteps = transcript.maxStepIndex !== null
      ? steps.filter((step) => step.idx > transcript.maxStepIndex!)
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
      ? steps.map((s) => s.timestampMs).filter((t): t is number => t !== undefined)
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
}

export function parseAntigravitySessions(
  filePath: string,
  options?: AntigravitySnapshotOptions,
): ParsedSession {
  const snapshot = readAntigravityConversationSnapshot(filePath, {
    includeTranscript: true,
    includeSummary: true,
    retryDelaysMs: options?.retryDelaysMs,
    busyTimeoutMs: options?.busyTimeoutMs,
    throwOnError: options?.throwOnError ?? true,
  });
  return antigravitySnapshotToParsedSession(snapshot);
}
