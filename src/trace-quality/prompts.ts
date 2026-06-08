import { createHash } from 'node:crypto';
import { TRACE_QUALITY_PROMPT_REF_SOURCES } from './constants.js';
import type {
  TraceQualityObservationRow,
  TraceQualityPromptRefRow,
  TraceQualityPromptRefSource,
} from './types.js';

export type ProjectedTraceQualityPromptRef = Omit<TraceQualityPromptRefRow, 'id' | 'created_at'>;

export interface ProjectedTraceQualityObservationPrompt {
  observation_id: string;
  prompt_ref: ProjectedTraceQualityPromptRef;
}

export interface PromptAttributionResult {
  links: ProjectedTraceQualityObservationPrompt[];
  warnings: string[];
}

type PromptableObservation = Pick<
  TraceQualityObservationRow,
  'id' | 'observation_type' | 'source_kind' | 'source_id'
>;

const PROMPT_REF_SOURCE_SET = new Set<string>(TRACE_QUALITY_PROMPT_REF_SOURCES);
const CANONICAL_PROMPT_SOURCES = new Set<string>([
  'metadata',
  'skill_file',
  'agent_instruction',
  'task_template',
  'system_prompt',
  'manual',
]);

const EXPLICIT_NESTED_KEYS = ['prompt_ref', 'promptRef', 'prompt_metadata', 'promptMetadata', 'prompt'];

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function promptContext(kind: string, id: string | number | null | undefined): string {
  return id == null ? kind : `${kind}:${id}`;
}

function normalizeSource(value: string | null, fallback: TraceQualityPromptRefSource): TraceQualityPromptRefSource {
  if (!value) return fallback;
  if (CANONICAL_PROMPT_SOURCES.has(value)) return value as TraceQualityPromptRefSource;
  switch (value) {
    case 'skill':
      return 'skill_file';
    case 'template':
      return 'task_template';
    case 'file':
      return 'system_prompt';
    case 'inline':
      return 'manual';
    default:
      return PROMPT_REF_SOURCE_SET.has(value) ? value as TraceQualityPromptRefSource : fallback;
  }
}

function serializeMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function explicitPromptHints(record: Record<string, unknown>, allowGenericName: boolean): boolean {
  const keys = [
    'prompt_name',
    'promptName',
    'prompt_version',
    'promptVersion',
    'prompt_label',
    'promptLabel',
    'prompt_hash',
    'promptHash',
    'content_hash',
    'contentHash',
    'prompt_source',
    'promptSource',
  ];
  if (allowGenericName) keys.push('name', 'version', 'label', 'hash', 'source');
  return keys.some(key => record[key] != null);
}

function explicitPromptFromRecord(
  record: Record<string, unknown>,
  options: {
    context: string;
    path: string;
    allowGenericName: boolean;
    fallbackSource: TraceQualityPromptRefSource;
  },
): { ref: ProjectedTraceQualityPromptRef | null; warning: string | null } {
  const name = firstString(record, options.allowGenericName
    ? ['prompt_name', 'promptName', 'name']
    : ['prompt_name', 'promptName']);
  const hasHints = explicitPromptHints(record, options.allowGenericName);
  if (!name) {
    return {
      ref: null,
      warning: hasHints
        ? `Ambiguous prompt attribution for ${options.context}: prompt metadata at ${options.path} omitted because prompt_name is missing`
        : null,
    };
  }

  const source = normalizeSource(
    firstString(record, ['prompt_source', 'promptSource', 'source']),
    options.fallbackSource,
  );
  const contentHash = firstString(record, [
    'prompt_hash',
    'promptHash',
    'content_hash',
    'contentHash',
    'hash',
  ]);

  return {
    ref: {
      name,
      version: firstString(record, ['prompt_version', 'promptVersion', 'version']),
      label: firstString(record, ['prompt_label', 'promptLabel', 'label']),
      source,
      content_hash: contentHash,
      file_path: firstString(record, ['prompt_file_path', 'promptFilePath', 'file_path', 'path']),
      metadata_json: serializeMetadata({
        attribution: 'explicit_metadata',
        metadata_path: options.path,
      }),
    },
    warning: null,
  };
}

function findExplicitPromptRef(
  record: Record<string, unknown> | undefined,
  context: string,
): { ref: ProjectedTraceQualityPromptRef | null; warning: string | null } {
  if (!record) return { ref: null, warning: null };

  const root = explicitPromptFromRecord(record, {
    context,
    path: 'root',
    allowGenericName: false,
    fallbackSource: 'metadata',
  });
  if (root.ref || root.warning) return root;

  for (const key of EXPLICIT_NESTED_KEYS) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    const result = explicitPromptFromRecord(nested, {
      context,
      path: key,
      allowGenericName: true,
      fallbackSource: 'metadata',
    });
    if (result.ref || result.warning) return result;
  }

  return { ref: null, warning: null };
}

function taskTemplateFromRecord(
  record: Record<string, unknown> | undefined,
  context: string,
): { ref: ProjectedTraceQualityPromptRef | null; warning: string | null } {
  if (!record) return { ref: null, warning: null };

  const nestedTemplate = asRecord(record.task_template) ?? asRecord(record.taskTemplate);
  const templateRecord = nestedTemplate ?? record;
  const hasTemplateHints = [
    'task_template',
    'taskTemplate',
    'task_template_name',
    'taskTemplateName',
    'task_template_version',
    'taskTemplateVersion',
    'task_template_hash',
    'taskTemplateHash',
    'template_name',
    'templateName',
    'template_version',
    'templateVersion',
    'template_hash',
    'templateHash',
  ].some(key => record[key] != null || templateRecord[key] != null);

  if (!hasTemplateHints) return { ref: null, warning: null };

  const templateName = firstString(templateRecord, [
    'task_template_name',
    'taskTemplateName',
    'template_name',
    'templateName',
    ...(nestedTemplate ? ['name'] : []),
  ]);

  if (!templateName) {
    return {
      ref: null,
      warning: `Ambiguous prompt attribution for ${context}: task template metadata omitted because template name is missing`,
    };
  }

  return {
    ref: {
      name: `task_template:${templateName}`,
      version: firstString(templateRecord, [
        'task_template_version',
        'taskTemplateVersion',
        'template_version',
        'templateVersion',
        'version',
      ]),
      label: firstString(templateRecord, ['task_template_label', 'taskTemplateLabel', 'template_label', 'templateLabel', 'label']),
      source: 'task_template',
      content_hash: firstString(templateRecord, [
        'task_template_hash',
        'taskTemplateHash',
        'template_hash',
        'templateHash',
        'content_hash',
        'contentHash',
      ]),
      file_path: firstString(templateRecord, ['task_template_path', 'taskTemplatePath', 'template_path', 'templatePath', 'file_path']),
      metadata_json: serializeMetadata({
        attribution: 'explicit_task_template',
        metadata_path: nestedTemplate ? 'task_template' : 'root',
      }),
    },
    warning: null,
  };
}

function inputRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  return [
    record,
    asRecord(record.input),
    asRecord(record.arguments),
    asRecord(record.params),
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function toolNameFromRecord(record: Record<string, unknown> | undefined, fallback: string | null): string | null {
  if (!record) return fallback;
  return firstString(record, ['tool_name', 'toolName', 'name']) ?? fallback;
}

function inferClaudeSkillRef(
  record: Record<string, unknown> | undefined,
  context: string,
  fallbackToolName: string | null,
): ProjectedTraceQualityPromptRef | null {
  if (!record || toolNameFromRecord(record, fallbackToolName) !== 'Skill') return null;

  for (const candidate of inputRecords(record)) {
    const skillName = firstString(candidate, ['skill', 'skill_name', 'skillName', 'name']);
    if (!skillName) continue;
    return {
      name: `skill:${skillName}`,
      version: null,
      label: null,
      source: 'skill_file',
      content_hash: stableHash({ source: 'claude_skill_tool', skillName }),
      file_path: null,
      metadata_json: serializeMetadata({
        attribution: 'inferred',
        inferred_from: 'claude_skill_tool',
        skill_name: skillName,
        source_context: context,
      }),
    };
  }

  return null;
}

function normalizeFilePath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function skillNameFromSkillPath(filePath: string): { skillName: string | null; ambiguous: boolean } {
  const normalized = normalizeFilePath(filePath);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.at(-1) !== 'SKILL.md') return { skillName: null, ambiguous: false };

  const skillsIndex = parts.lastIndexOf('skills');
  const parent = parts.at(-2);
  if (skillsIndex === -1 || !parent || skillsIndex >= parts.length - 2) {
    return { skillName: null, ambiguous: true };
  }

  return { skillName: parent, ambiguous: false };
}

function directFilePaths(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const paths = new Set<string>();
  for (const candidate of inputRecords(record)) {
    for (const key of ['file_path', 'filePath', 'path']) {
      const value = asString(candidate[key]);
      if (value) paths.add(normalizeFilePath(value));
    }
  }
  return [...paths];
}

function commandStrings(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const commands = new Set<string>();
  for (const candidate of inputRecords(record)) {
    for (const key of ['cmd', 'command', 'arguments', 'input']) {
      const value = asString(candidate[key]);
      if (value) commands.add(value);
    }
  }
  return [...commands];
}

function skillPathsFromCommand(command: string): string[] {
  const paths = new Set<string>();
  const pattern = /(?:^|[\s'"])(~?\/[^\s'"]*\/skills\/(?:[^\s'"]+\/)*[^/\s'"]+\/SKILL\.md)(?=$|[\s'"])/g;
  for (const match of command.matchAll(pattern)) {
    const filePath = match[1];
    if (filePath) paths.add(normalizeFilePath(filePath));
  }
  return [...paths];
}

function skillRefFromPath(filePath: string, context: string): { ref: ProjectedTraceQualityPromptRef | null; warning: string | null } {
  const { skillName, ambiguous } = skillNameFromSkillPath(filePath);
  if (!skillName) {
    return {
      ref: null,
      warning: ambiguous
        ? `Ambiguous prompt attribution for ${context}: SKILL.md path is not under a skills directory`
        : null,
    };
  }

  return {
    ref: {
      name: `skill:${skillName}`,
      version: null,
      label: null,
      source: 'skill_file',
      content_hash: stableHash({ source: 'skill_file_read', skillName, filePath }),
      file_path: filePath,
      metadata_json: serializeMetadata({
        attribution: 'inferred',
        inferred_from: 'skill_file_read',
        skill_name: skillName,
        source_context: context,
      }),
    },
    warning: null,
  };
}

function inferSkillFileRefs(
  record: Record<string, unknown> | undefined,
  context: string,
  fallbackToolName: string | null,
): { refs: ProjectedTraceQualityPromptRef[]; warnings: string[] } {
  const claudeSkill = inferClaudeSkillRef(record, context, fallbackToolName);
  if (claudeSkill) return { refs: [claudeSkill], warnings: [] };

  const refs: ProjectedTraceQualityPromptRef[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  for (const filePath of [
    ...directFilePaths(record),
    ...commandStrings(record).flatMap(skillPathsFromCommand),
  ]) {
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    const result = skillRefFromPath(filePath, context);
    if (result.ref) refs.push(result.ref);
    if (result.warning) warnings.push(result.warning);
  }

  return { refs, warnings };
}

function buildResult(
  observation: PromptableObservation,
  refs: ProjectedTraceQualityPromptRef[],
  warnings: string[],
): PromptAttributionResult {
  const seen = new Set<string>();
  const links = refs.flatMap(promptRef => {
    const key = stablePromptRefKey(promptRef);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ observation_id: observation.id, prompt_ref: promptRef }];
  });
  return { links, warnings };
}

function inferPromptRefs(
  input: {
    observation: PromptableObservation;
    record: Record<string, unknown> | undefined;
    context: string;
    toolName?: string | null;
  },
): PromptAttributionResult {
  const explicit = findExplicitPromptRef(input.record, input.context);
  if (explicit.ref || explicit.warning) {
    return buildResult(input.observation, explicit.ref ? [explicit.ref] : [], explicit.warning ? [explicit.warning] : []);
  }

  const template = taskTemplateFromRecord(input.record, input.context);
  if (template.ref || template.warning) {
    return buildResult(input.observation, template.ref ? [template.ref] : [], template.warning ? [template.warning] : []);
  }

  const skills = inferSkillFileRefs(input.record, input.context, input.toolName ?? null);
  return buildResult(input.observation, skills.refs, skills.warnings);
}

export function promptAttributionForEvent(input: {
  observation: PromptableObservation;
  eventId: string | number | null | undefined;
  metadata: Record<string, unknown> | undefined;
  toolName?: string | null;
}): PromptAttributionResult {
  return inferPromptRefs({
    observation: input.observation,
    record: input.metadata,
    context: promptContext('event', input.eventId),
    toolName: input.toolName ?? null,
  });
}

export function promptAttributionForSessionItem(input: {
  observation: PromptableObservation;
  itemId: string | number | null | undefined;
  payload: Record<string, unknown> | undefined;
}): PromptAttributionResult {
  return inferPromptRefs({
    observation: input.observation,
    record: input.payload,
    context: promptContext('session_item', input.itemId),
    toolName: toolNameFromRecord(input.payload, null),
  });
}

export function promptAttributionForToolCall(input: {
  observation: PromptableObservation;
  toolCallId: string | number | null | undefined;
  toolName: string | null;
  input: Record<string, unknown> | undefined;
}): PromptAttributionResult {
  return inferPromptRefs({
    observation: input.observation,
    record: input.input,
    context: promptContext('tool_call', input.toolCallId),
    toolName: input.toolName,
  });
}

export function stablePromptRefKey(promptRef: ProjectedTraceQualityPromptRef): string {
  return JSON.stringify([
    promptRef.name,
    promptRef.version,
    promptRef.source,
    promptRef.content_hash,
    promptRef.file_path,
  ]);
}
