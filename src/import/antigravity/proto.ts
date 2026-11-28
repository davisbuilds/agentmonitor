
import {
  STEP_FIELDS,
  STEP_PAYLOAD_KINDS,
  USAGE_METADATA_FIELDS,
  GEN_METADATA_WRAPPER_FIELD,
  GENERATOR_METADATA_FIELDS,
  CHAT_START_METADATA_FIELDS,
  CORTEX_USAGE_FIELDS,
  PLANNER_RESPONSE_FIELDS,
  STEP_METADATA_FIELDS,
  CHAT_TOOL_CALL_FIELDS,
} from './fieldmap.js';

export type WireType = 0 | 1 | 2 | 5;

export interface ProtoField {
  wire: WireType;
  /** present for wire type 0 (varint) */
  value?: number;
  /** present for wire type 2 (length-delimited) */
  bytes?: Buffer;
}

/** Read a base-128 varint as a JS number (safe for the <=2^53 counts we decode). */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new RangeError('varint truncated');
    const byte = buf[p++];
    // WHY: JavaScript shifts truncate to 32 bits; multibyte varints can exceed that width.
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new RangeError('varint too long');
  }
  return [result, p];
}

/** Decode a protobuf message into a map of field number -> occurrences. */
export function decodeMessage(buf: Buffer): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let pos = 0;
  while (pos < buf.length) {
    let key: number;
    try {
      [key, pos] = readVarint(buf, pos);
    } catch {
      break;
    }
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let entry: ProtoField;
    if (wire === 0) {
      let value: number;
      try {
        [value, pos] = readVarint(buf, pos);
      } catch {
        break;
      }
      entry = { wire, value };
    } else if (wire === 2) {
      let len: number;
      try {
        [len, pos] = readVarint(buf, pos);
      } catch {
        break;
      }
      if (len < 0 || pos + len > buf.length) break;
      entry = { wire, bytes: buf.subarray(pos, pos + len) };
      pos += len;
    } else if (wire === 5) {
      pos += 4;
      entry = { wire };
    } else if (wire === 1) {
      pos += 8;
      entry = { wire };
    } else {
      break;
    }
    const list = fields.get(field);
    if (list) list.push(entry);
    else fields.set(field, [entry]);
  }
  return fields;
}

/** First varint value for a field, or undefined. */
export function getVarint(
  fields: Map<number, ProtoField[]>,
  field: number,
): number | undefined {
  return fields.get(field)?.[0]?.value;
}

function getBytes(
  fields: Map<number, ProtoField[]>,
  field: number,
): Buffer | undefined {
  return fields.get(field)?.[0]?.bytes;
}

function getString(
  fields: Map<number, ProtoField[]>,
  field: number,
): string | undefined {
  const bytes = getBytes(fields, field);
  if (!bytes || bytes.length === 0) return undefined;
  const text = bytes.toString('utf-8');
  return text.trim().length > 0 ? text : undefined;
}

export interface PlannerResponseIds {
  messageId?: string;
  providerAssignedMessageId?: string;
}

export interface AntigravityChatToolCall {
  id?: string;
  name?: string;
  argumentsJson?: string;
}

export interface StepEnvelope {
  type?: number;
  status?: number;
  kind?: string;
  hasMetadata: boolean;
  hasError: boolean;
  plannerIds?: PlannerResponseIds;
  plannerToolCalls?: AntigravityChatToolCall[];
  metadataToolCall?: AntigravityChatToolCall;
}

function decodeChatToolCall(bytes: Buffer): AntigravityChatToolCall | undefined {
  const fields = decodeMessage(bytes);
  const id = getString(fields, CHAT_TOOL_CALL_FIELDS.id);
  const name = getString(fields, CHAT_TOOL_CALL_FIELDS.name);
  const argumentsJson = getString(fields, CHAT_TOOL_CALL_FIELDS.argumentsJson);
  if (id === undefined && name === undefined && argumentsJson === undefined) return undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(argumentsJson !== undefined ? { argumentsJson } : {}),
  };
}

export function decodeStepToolCall(metadata: Buffer): AntigravityChatToolCall | undefined {
  const raw = getBytes(decodeMessage(metadata), STEP_METADATA_FIELDS.toolCall);
  return raw ? decodeChatToolCall(raw) : undefined;
}

export function decodeStepEnvelope(stepPayload: Buffer): StepEnvelope {
  const f = decodeMessage(stepPayload);
  let kind: string | undefined;
  let kindField: number | undefined;
  for (const [num, name] of Object.entries(STEP_PAYLOAD_KINDS)) {
    const fieldNum = Number(num);
    if (f.has(fieldNum)) {
      kind = name;
      kindField = fieldNum;
      break;
    }
  }
  let plannerIds: PlannerResponseIds | undefined;
  let plannerToolCalls: AntigravityChatToolCall[] | undefined;
  if (kind === 'planner_response' && kindField !== undefined) {
    const plannerBytes = getBytes(f, kindField);
    if (plannerBytes) {
      const pf = decodeMessage(plannerBytes);
      const messageId = getString(pf, PLANNER_RESPONSE_FIELDS.messageId);
      const providerAssignedMessageId = getString(pf, PLANNER_RESPONSE_FIELDS.providerAssignedMessageId);
      if (messageId !== undefined || providerAssignedMessageId !== undefined) {
        plannerIds = { messageId, providerAssignedMessageId };
      }
      const rawCalls = pf.get(PLANNER_RESPONSE_FIELDS.toolCalls) ?? [];
      const decodedCalls: AntigravityChatToolCall[] = [];
      for (const entry of rawCalls) {
        if (!entry.bytes) continue;
        const decoded = decodeChatToolCall(entry.bytes);
        if (decoded) decodedCalls.push(decoded);
      }
      if (decodedCalls.length > 0) plannerToolCalls = decodedCalls;
    }
  }
  const envelopeMeta = getBytes(f, STEP_FIELDS.metadata);
  const metadataToolCall = envelopeMeta ? decodeStepToolCall(envelopeMeta) : undefined;
  return {
    type: getVarint(f, STEP_FIELDS.type),
    status: getVarint(f, STEP_FIELDS.status),
    kind,
    hasMetadata: f.has(STEP_FIELDS.metadata),
    hasError: f.has(STEP_FIELDS.error),
    ...(plannerIds ? { plannerIds } : {}),
    ...(plannerToolCalls ? { plannerToolCalls } : {}),
    ...(metadataToolCall ? { metadataToolCall } : {}),
  };
}

function decodeProtoTimestampMs(stamp: Buffer): number | undefined {
  const fields = decodeMessage(stamp);
  const secs = getVarint(fields, 1);
  // WHY: A plausible integer from an unknown field need not be a timestamp.
  if (secs === undefined || secs < 1_000_000_000 || secs > 4_000_000_000) return undefined;
  const nanos = getVarint(fields, 2) ?? 0;
  const ms = nanos >= 0 && nanos < 1_000_000_000 ? Math.floor(nanos / 1_000_000) : 0;
  return secs * 1000 + ms;
}

export function decodeStepTimestampMs(metadata: Buffer): number | undefined {
  const inner = getBytes(decodeMessage(metadata), STEP_METADATA_FIELDS.createdAt);
  if (!inner) return undefined;
  return decodeProtoTimestampMs(inner);
}

export interface GoogleUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount: number;
  toolUsePromptTokenCount: number;
  thoughtsTokenCount: number;
}

/**
 * Decode a google.cloud.aiplatform.master.UsageMetadata message.
 *
 * NOTE: in shipped Antigravity conversation DBs this schema appears as the
 * request generation *config* (e.g. max_output_tokens), not the persisted
 * response usage — the real per-turn accounting is the private
 * CortexGeneratorMetadata message (fields num_input_tokens / num_output_tokens /
 * thinking_output_tokens), whose field numbers are not yet descriptor-pinned.
 * See the baseline doc "Real token accounting" section. This decoder is kept
 * because the schema is authoritative; wiring the cost-bearing source is Task 3.
 */
export function decodeGoogleUsage(bytes: Buffer): GoogleUsage {
  const f = decodeMessage(bytes);
  return {
    promptTokenCount: getVarint(f, USAGE_METADATA_FIELDS.promptTokenCount) ?? 0,
    candidatesTokenCount: getVarint(f, USAGE_METADATA_FIELDS.candidatesTokenCount) ?? 0,
    totalTokenCount: getVarint(f, USAGE_METADATA_FIELDS.totalTokenCount) ?? 0,
    cachedContentTokenCount: getVarint(f, USAGE_METADATA_FIELDS.cachedContentTokenCount) ?? 0,
    toolUsePromptTokenCount: getVarint(f, USAGE_METADATA_FIELDS.toolUsePromptTokenCount) ?? 0,
    thoughtsTokenCount: getVarint(f, USAGE_METADATA_FIELDS.thoughtsTokenCount) ?? 0,
  };
}

export interface CortexUsage {
  modelEnum: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  answerTokens: number;
}

export interface GeneratorMetadata {
  model?: string;
  usage?: CortexUsage;
  timestampMs?: number;
  messageId?: string;
  providerAssignedMessageId?: string;
}

export function decodeGeneratorMetadata(blob: Buffer): GeneratorMetadata {
  const wrapper = decodeMessage(blob);
  const gmBytes = getBytes(wrapper, GEN_METADATA_WRAPPER_FIELD);
  if (!gmBytes) return {};
  const gm = decodeMessage(gmBytes);

  const model =
    getString(gm, GENERATOR_METADATA_FIELDS.model) ??
    getString(gm, GENERATOR_METADATA_FIELDS.modelFull) ??
    getString(gm, GENERATOR_METADATA_FIELDS.modelDisplay);

  const usageBytes = getBytes(gm, GENERATOR_METADATA_FIELDS.usage);
  let usage: CortexUsage | undefined;
  let messageId: string | undefined;
  let providerAssignedMessageId: string | undefined;
  if (usageBytes) {
    const u = decodeMessage(usageBytes);
    usage = {
      modelEnum: getVarint(u, CORTEX_USAGE_FIELDS.modelEnum) ?? 0,
      inputTokens: getVarint(u, CORTEX_USAGE_FIELDS.inputTokens) ?? 0,
      outputTokens: getVarint(u, CORTEX_USAGE_FIELDS.outputTokens) ?? 0,
      cacheWriteTokens: getVarint(u, CORTEX_USAGE_FIELDS.cacheWriteTokens) ?? 0,
      cacheReadTokens: getVarint(u, CORTEX_USAGE_FIELDS.cacheReadTokens) ?? 0,
      thinkingTokens: getVarint(u, CORTEX_USAGE_FIELDS.thinkingTokens) ?? 0,
      answerTokens: getVarint(u, CORTEX_USAGE_FIELDS.answerTokens) ?? 0,
    };
    messageId = getString(u, CORTEX_USAGE_FIELDS.messageId);
    providerAssignedMessageId = getString(u, CORTEX_USAGE_FIELDS.providerAssignedMessageId);
  }
  return {
    model,
    usage,
    timestampMs: decodeGenerationTimestampMs(gm),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(providerAssignedMessageId !== undefined ? { providerAssignedMessageId } : {}),
  };
}

function decodeGenerationTimestampMs(gm: Map<number, ProtoField[]>): number | undefined {
  const chatStart = getBytes(gm, GENERATOR_METADATA_FIELDS.chatStartMetadata);
  const stamp = chatStart && getBytes(decodeMessage(chatStart), CHAT_START_METADATA_FIELDS.createdAt);
  if (!stamp) return undefined;
  return decodeProtoTimestampMs(stamp);
}

export interface BillingTokens {
  tokensIn: number;
  tokensOut: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  thoughtsTokens: number;
}

export function deriveBillingTokens(u: CortexUsage): BillingTokens {
  return {
    tokensIn: u.inputTokens,
    tokensOut: u.outputTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    cacheReadTokens: u.cacheReadTokens,
    thoughtsTokens: u.thinkingTokens,
  };
}
