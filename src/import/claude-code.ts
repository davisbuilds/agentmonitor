import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { NormalizedIngestEvent, EventType } from '../contracts/event-contract.js';
import { discoverJsonlFilesRecursive } from '../util/file-discovery.js';
import { claudeInvocationMode } from '../util/invocation-mode.js';
import { projectNameFromCwd } from '../util/project-identity.js';

interface ClaudeCodeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface ClaudeCodeMessage {
  id?: string;
  model?: string;
  usage?: ClaudeCodeUsage;
  content?: unknown;
  stop_reason?: string;
}

interface ClaudeCodeLogLine {
  type?: string;
  sessionId?: string;
  uuid?: string;
  agentId?: string;
  isSidechain?: boolean;
  model?: string;
  costUSD?: number;
  usage?: ClaudeCodeUsage;
  message?: ClaudeCodeMessage;
  timestamp?: string;
  name?: string;
  tool_name?: string;
  content?: unknown;
  duration_ms?: number;
  durationMs?: number;
  error?: string | { message?: string };
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  promptSource?: string; // WHY: Desktop and headless clients can both use the SDK transport.
  is_error?: boolean;
  status?: string;
  input?: unknown;
  output?: unknown;
}

const TYPE_MAP: Record<string, EventType> = {
  tool_use: 'tool_use',
  tool_result: 'tool_use',
  assistant: 'llm_response',
  error: 'error',
  session_start: 'session_start',
  session_end: 'session_end',
};

export function discoverClaudeCodeLogs(
  baseDir?: string,
  options: { excludePatterns?: string[] } = {},
): string[] {
  const claudeDir = baseDir ?? path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  return discoverJsonlFilesRecursive(projectsDir, { excludePatterns: options.excludePatterns });
}

/**
 * An event plus the id the positional scheme would have given it. The importer
 * uses `legacy_event_id` to recognize rows stored before ids moved onto the
 * producer's `uuid`; it is never persisted.
 */
export type ParsedImportEvent = NormalizedIngestEvent & { legacy_event_id?: string };

export function parseClaudeCodeFile(
  filePath: string,
  options?: { from?: Date; to?: Date },
): ParsedImportEvent[] {
  const events: ParsedImportEvent[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const fileBasename = path.basename(filePath, '.jsonl');

  // WHY: Child-agent files report their parent's session ID; the filename identifies the physical
  // child.
  const childAgentTranscript = fileBasename.startsWith('agent-');

  let prevCostUSD = 0;

  // WHY: Each content-block line repeats the whole turn's usage, so billing every line would
  // multiply the cost.
  const parsed = lines.map(text => {
    try {
      return JSON.parse(text) as ClaudeCodeLogLine;
    } catch {
      return undefined;
    }
  });
  const finalUsage = new Map<string, NonNullable<ClaudeCodeLogLine['usage']>>();
  for (const line of parsed) {
    const usage = line?.usage ?? line?.message?.usage;
    const messageId = line?.message?.id;
    if (messageId !== undefined && usage) finalUsage.set(messageId, usage);
  }
  const billedMessageIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = parsed[i];
    if (!line?.type) continue;

    const sessionId = line.sessionId ?? fileBasename;

    const eventType = TYPE_MAP[line.type] ?? 'response';

    const toolName = line.name ?? line.tool_name;

    const msg = line.message;
    const model = line.model ?? msg?.model;
    const usage = line.usage ?? msg?.usage;

    let costDelta: number | undefined;
    if (typeof line.costUSD === 'number' && line.costUSD > 0) {
      costDelta = line.costUSD - prevCostUSD;
      if (costDelta < 0) costDelta = 0;
      prevCostUSD = line.costUSD;
    }

    const messageId = msg?.id;
    const alreadyBilled = messageId !== undefined && billedMessageIds.has(messageId);
    if (messageId !== undefined && usage) billedMessageIds.add(messageId);
    const turnUsage = usage && messageId !== undefined ? finalUsage.get(messageId) ?? usage : usage;

    const tokensIn = alreadyBilled ? 0 : turnUsage?.input_tokens ?? 0;
    const tokensOut = alreadyBilled ? 0 : turnUsage?.output_tokens ?? 0;
    const cacheRead = alreadyBilled ? 0 : turnUsage?.cache_read_input_tokens ?? 0;
    const cacheWrite = alreadyBilled ? 0 : turnUsage?.cache_creation_input_tokens ?? 0;
    const cacheWrite1h = Math.min(cacheWrite, alreadyBilled ? 0 : turnUsage?.cache_creation?.ephemeral_1h_input_tokens ?? 0);

    // WHY: Applying the date filter before turn deduplication could bill the same turn again in a
    // later window.
    if (line.timestamp && options?.from) {
      const ts = new Date(line.timestamp);
      if (ts < options.from) continue;
    }
    if (line.timestamp && options?.to) {
      const ts = new Date(line.timestamp);
      if (ts > options.to) continue;
    }

    const project = projectNameFromCwd(line.cwd) ?? undefined;
    const branch = line.gitBranch;

    let status: 'success' | 'error' | 'timeout' = 'success';
    if (line.type === 'error' || line.is_error || line.status === 'error') {
      status = 'error';
    }

    const legacyEventId = `import-cc-${crypto
      .createHash('sha256')
      .update(`claude-code:${sessionId}:${i}`)
      .digest('hex')
      .slice(0, 32)}`;
    // WHY: A child file reports its parent session, so positional fallback IDs must include the
    // physical transcript identity.
    const positionalEventId = childAgentTranscript
      ? `import-cca-${crypto
          .createHash('sha256')
          .update(`claude-code:transcript:${fileBasename}:${i}`)
          .digest('hex')
          .slice(0, 32)}`
      : legacyEventId;
    const eventId = line.uuid
      ? `import-ccu-${crypto
          .createHash('sha256')
          .update(`claude-code:uuid:${line.uuid}`)
          .digest('hex')
          .slice(0, 32)}`
      : positionalEventId;

    const metadataObj: Record<string, unknown> = {};
    if (childAgentTranscript) {
      metadataObj.agent_id = line.agentId ?? fileBasename.slice('agent-'.length);
      metadataObj.agent_transcript = fileBasename;
    }
    if (typeof line.error === 'string') metadataObj.error = line.error;
    else if (line.error?.message) metadataObj.error = line.error.message;

    if (line.content !== undefined) {
      if (typeof line.content === 'string') {
        metadataObj.content_preview = line.content.slice(0, 500);
      } else if (Array.isArray(line.content)) {
        const textParts: string[] = [];
        for (const block of line.content) {
          if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          metadataObj.content_preview = textParts.join('\n').slice(0, 500);
        }
      }
    }

    if (line.type === 'tool_use' && line.input) {
      if (typeof line.input === 'object' && line.input !== null) {
        const inp = line.input as Record<string, unknown>;
        if (inp.command) metadataObj.command = String(inp.command).slice(0, 200);
        if (inp.file_path) metadataObj.file_path = String(inp.file_path);
        if (inp.pattern) metadataObj.pattern = String(inp.pattern);
        if (inp.query) metadataObj.query = String(inp.query);

        const tn = toolName ?? '';
        if (tn === 'Edit' || tn === 'MultiEdit') {
          if (typeof inp.old_string === 'string' && inp.old_string) {
            metadataObj.lines_removed = inp.old_string.split('\n').length;
          }
          if (typeof inp.new_string === 'string' && inp.new_string) {
            metadataObj.lines_added = inp.new_string.split('\n').length;
          }
        } else if (tn === 'Write') {
          if (typeof inp.content === 'string' && inp.content) {
            metadataObj.lines_added = inp.content.split('\n').length;
          }
        }
      }
    }
    if (line.type === 'tool_result' && line.output !== undefined) {
      const outputStr = typeof line.output === 'string' ? line.output : JSON.stringify(line.output);
      metadataObj.content_preview = outputStr.slice(0, 500);
    }

    const event: ParsedImportEvent = {
      event_id: eventId,
      legacy_event_id: legacyEventId,
      session_id: sessionId,
      agent_type: 'claude_code',
      event_type: eventType,
      tool_name: eventType === 'tool_use' ? toolName : undefined,
      status,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cache_write_1h_tokens: cacheWrite1h,
      model,
      cost_usd: !alreadyBilled && costDelta && costDelta > 0 ? costDelta : undefined,
      duration_ms: line.duration_ms ?? line.durationMs,
      project,
      branch,
      client_timestamp: line.timestamp,
      metadata: Object.keys(metadataObj).length > 0 ? metadataObj : {},
      source: 'import',
      mode: claudeInvocationMode(line.entrypoint, line.promptSource),
    };

    events.push(event);
  }

  return events;
}


export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
