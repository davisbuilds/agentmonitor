import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_CHARACTERS = ['$', '*', '?', '[', ']', '{', '}'];

const RECOGNIZED_SKILL_ROOT_SUFFIXES = [
  '/.gemini/config/skills',
  '/.gemini/antigravity-cli/builtin/skills',
  '/.gemini/skills',
  '/.agents/skills',
  '/.claude/skills',
  '/.codex/skills',
] as const;

const RELATIVE_SKILL_ROOT_PREFIXES = new Set([
  '.gemini/config/skills',
  '.gemini/antigravity-cli/builtin/skills',
  '.gemini/skills',
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
]);

const FILE_READ_PATH_KEYS = [
  'Path',
  'path',
  'AbsolutePath',
  'absolute_path',
  'file_path',
  'filePath',
  'TargetFile',
  'target_file',
  'uri',
] as const;

const ANTIGRAVITY_FILE_READ_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_content_chunk',
  'read_resource',
]);

const ANTIGRAVITY_SHELL_TOOLS = new Set([
  'run_command',
  'shell_exec',
]);

export const ANTIGRAVITY_SKILL_TOOL_NAMES = [
  'read_file',
  'view_file',
  'view_content_chunk',
  'read_resource',
  'run_command',
  'shell_exec',
] as const;

const SHELL_READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'less',
  'more',
  'nl',
  'bat',
]);

function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isConcreteSkillName(skillName: string | undefined): skillName is string {
  if (!skillName) return false;
  return skillName !== '.'
    && skillName !== '..'
    && !PLACEHOLDER_CHARACTERS.some(character => skillName.includes(character));
}

function toNormalizedPosixPath(rawPath: string, cwd?: string | null): string | null {
  let candidate = rawPath.trim();
  if (!candidate) return null;
  if (
    (candidate.startsWith('"') && candidate.endsWith('"'))
    || (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (!candidate) return null;
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      candidate = candidate.slice('file://'.length);
    }
  }
  if (candidate === '~') {
    candidate = os.homedir();
  } else if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  const posixCandidate = candidate.replaceAll('\\', '/');
  if (posixCandidate.startsWith('/')) {
    return path.posix.normalize(posixCandidate);
  }
  if (cwd?.trim()) {
    const posixCwd = cwd.trim().replaceAll('\\', '/');
    return path.posix.normalize(path.posix.join(posixCwd, posixCandidate));
  }
  return path.posix.normalize(posixCandidate);
}

function normalizeExtraRoot(root: string): string | null {
  const normalized = toNormalizedPosixPath(root);
  if (!normalized) return null;
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isRecognizedSkillRoot(
  rootDir: string,
  extraRoots?: readonly string[],
): boolean {
  const trimmed = rootDir.length > 1 && rootDir.endsWith('/') ? rootDir.slice(0, -1) : rootDir;
  if (RELATIVE_SKILL_ROOT_PREFIXES.has(trimmed)) return true;
  if (RECOGNIZED_SKILL_ROOT_SUFFIXES.some(suffix => trimmed.endsWith(suffix))) return true;
  if (extraRoots) {
    for (const root of extraRoots) {
      const normalized = normalizeExtraRoot(root);
      if (normalized && trimmed === normalized) return true;
    }
  }
  return false;
}

function extractSkillNameFromPath(
  filePath: string,
  options?: { cwd?: string | null; extraRoots?: readonly string[] },
): string | undefined {
  const normalized = toNormalizedPosixPath(filePath, options?.cwd);
  if (!normalized || !normalized.endsWith('/SKILL.md')) return undefined;
  const skillDir = path.posix.dirname(normalized);
  const skillName = path.posix.basename(skillDir).trim();
  if (!isConcreteSkillName(skillName)) return undefined;
  const rootDir = path.posix.dirname(skillDir);
  if (!isRecognizedSkillRoot(rootDir, options?.extraRoots)) return undefined;
  return skillName;
}

export function extractCanonicalCodexSessionId(sessionId: string): string {
  const match = sessionId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? sessionId;
}

export function extractExplicitSkillName(inputJson: string | null): string | undefined {
  const record = asRecord(parseJson(inputJson));
  const skill = record?.['skill'];
  return typeof skill === 'string' && skill.trim() ? skill.trim() : undefined;
}

export function extractCodexCommandFromInputJson(inputJson: string | null): string | undefined {
  const parsed = parseJson(inputJson);
  if (typeof parsed === 'string') return parsed;

  const record = asRecord(parsed);
  if (!record) return undefined;
  const cmd = record['cmd'];
  if (typeof cmd === 'string') return cmd;
  const command = record['command'];
  if (typeof command === 'string') return command;
  const commandLine = record['CommandLine'];
  return typeof commandLine === 'string' ? commandLine : undefined;
}

export function extractCodexCommandFromEventMetadata(metadataJson: string | null): string | undefined {
  const record = asRecord(parseJson(metadataJson));
  if (!record) return undefined;

  const argumentsValue = record['arguments'];
  if (typeof argumentsValue === 'string') return argumentsValue;

  const argumentsRecord = asRecord(argumentsValue);
  if (argumentsRecord) {
    const cmd = argumentsRecord['cmd'];
    if (typeof cmd === 'string') return cmd;
    const command = argumentsRecord['command'];
    if (typeof command === 'string') return command;
  }

  const input = record['input'];
  return typeof input === 'string' ? input : undefined;
}

export function isAntigravityShellTool(toolName: string): boolean {
  return ANTIGRAVITY_SHELL_TOOLS.has(toolName);
}

export function hasAntigravityNonZeroExit(text: string): boolean {
  return /Command exited with code (?!0\b)-?\d+/.test(text);
}

interface ShellToken {
  value: string;
  isRedirect: boolean;
  skipsNextToken: boolean;
}

function parseHeredocDelimiter(
  command: string,
  start: number,
): { delimiter: string; nextIdx: number } | null {
  let i = start;
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
  if (i >= command.length) return null;

  let delimiter = '';
  let quote: "'" | '"' | null = null;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else delimiter += ch;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        delimiter += command[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      else delimiter += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      delimiter += command[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (/[\s;&|<>()]/.test(ch)) break;
    delimiter += ch;
    i++;
  }

  return delimiter ? { delimiter, nextIdx: i } : null;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1]!;
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1]!;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        current += '<<<';
        i += 2;
        continue;
      }
      const stripTabs = command[i + 2] === '-';
      const opLen = stripTabs ? 3 : 2;
      current += command.slice(i, i + opLen);
      const parsed = parseHeredocDelimiter(command, i + opLen);
      if (parsed) {
        pendingHeredocs.push({ delimiter: parsed.delimiter, stripTabs });
        current += command.slice(i + opLen, parsed.nextIdx);
        i = parsed.nextIdx - 1;
      } else {
        i += opLen - 1;
      }
      continue;
    }
    if (ch === '\n') {
      if (current.trim()) segments.push(current);
      current = '';
      if (pendingHeredocs.length > 0) {
        let cursor = i + 1;
        while (pendingHeredocs.length > 0 && cursor < command.length) {
          const target = pendingHeredocs.shift()!;
          while (cursor <= command.length) {
            const nextNl = command.indexOf('\n', cursor);
            const rawLine = nextNl === -1 ? command.slice(cursor) : command.slice(cursor, nextNl);
            const lineWithoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            const normalizedLine = target.stripTabs ? lineWithoutCr.replace(/^\t+/, '') : lineWithoutCr;
            cursor = nextNl === -1 ? command.length : nextNl + 1;
            if (normalizedLine === target.delimiter || nextNl === -1) break;
          }
        }
        i = cursor - 1;
      }
      continue;
    }
    if (ch === ';') {
      if (current.trim()) segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      if (current.trim()) segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        if (current.trim()) segments.push(current);
        current = '';
        i++;
        continue;
      }
      if (i > 0 && command[i - 1] === '>') {
        current += ch;
        continue;
      }
      if (current.trim()) segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) segments.push(current);
  return segments;
}

function tokenizeShellSegment(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let hasContent = false;
  let quote: "'" | '"' | null = null;

  const flushWord = () => {
    if (!hasContent) return;
    tokens.push({ value: current, isRedirect: false, skipsNextToken: false });
    current = '';
    hasContent = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
        hasContent = true;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < segment.length) {
        current += segment[i + 1]!;
        hasContent = true;
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
        hasContent = true;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[i + 1]!;
      hasContent = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    if (ch === '>') {
      const fdPrefix = hasContent && (/^\d+$/.test(current) || current === '&') ? current : '';
      if (fdPrefix) {
        current = '';
        hasContent = false;
      } else {
        flushWord();
      }
      let op = `${fdPrefix}>`;
      if (segment[i + 1] === '>' || segment[i + 1] === '|') {
        op += segment[i + 1]!;
        i++;
      }
      tokens.push({ value: op, isRedirect: true, skipsNextToken: true });
      continue;
    }
    if (ch === '<') {
      const fdPrefix = hasContent && /^\d+$/.test(current) ? current : '';
      if (fdPrefix) {
        current = '';
        hasContent = false;
      } else {
        flushWord();
      }
      if (segment[i + 1] === '>') {
        tokens.push({ value: `${fdPrefix}<>`, isRedirect: true, skipsNextToken: true });
        i++;
      } else if (segment[i + 1] === '<') {
        if (segment[i + 2] === '<') {
          tokens.push({ value: `${fdPrefix}<<<`, isRedirect: true, skipsNextToken: true });
          i += 2;
        } else if (segment[i + 2] === '-') {
          tokens.push({ value: `${fdPrefix}<<-`, isRedirect: true, skipsNextToken: true });
          i += 2;
        } else {
          tokens.push({ value: `${fdPrefix}<<`, isRedirect: true, skipsNextToken: true });
          i++;
        }
      } else {
        tokens.push({ value: `${fdPrefix}<`, isRedirect: true, skipsNextToken: false });
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }

  flushWord();
  return tokens;
}

function extractSkillPathMatches(tokens: readonly ShellToken[]): Array<{ fullPath: string; skillName: string }> {
  const matches: Array<{ fullPath: string; skillName: string }> = [];
  let skipNext = false;
  for (const tok of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (tok.isRedirect) {
      if (tok.skipsNextToken) skipNext = true;
      continue;
    }

    const candidate = tok.value;
    if (!candidate || !candidate.endsWith('/SKILL.md') || candidate.startsWith('-')) continue;
    const skillDir = path.posix.dirname(candidate);
    const skillName = path.posix.basename(skillDir).trim();
    if (isConcreteSkillName(skillName)) {
      matches.push({ fullPath: candidate, skillName });
    }
  }
  return matches;
}

export function extractCodexSkillNamesFromCommand(command: string): string[] {
  const skillNames = new Set<string>();
  const pattern = /(?:^|[\s'"])(~?\/[^\s'"]*\/([^/\s'"]+)\/SKILL\.md)(?=$|[\s'"])/g;

  for (const match of command.matchAll(pattern)) {
    const skillName = match[2]?.trim();
    if (isConcreteSkillName(skillName)) skillNames.add(skillName);
  }

  return [...skillNames];
}

function extractFileReadSegmentTokens(command: string): ShellToken[][] {
  const readSegments: ShellToken[][] = [];
  for (const segment of splitShellSegments(command)) {
    if (!segment.includes('SKILL.md')) continue;
    const tokens = tokenizeShellSegment(segment);
    let idx = 0;
    while (
      idx < tokens.length
      && !tokens[idx]!.isRedirect
      && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!.value)
    ) {
      idx++;
    }
    const cmdToken = tokens[idx];
    if (!cmdToken || cmdToken.isRedirect) continue;
    const base = path.posix.basename(cmdToken.value.replaceAll('\\', '/'));
    if (SHELL_READ_COMMANDS.has(base)) readSegments.push(tokens.slice(idx + 1));
  }
  return readSegments;
}

function extractAntigravityFileReadPath(inputJson: string | null): string | undefined {
  const record = asRecord(parseJson(inputJson));
  if (!record) return undefined;
  for (const key of FILE_READ_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function extractAntigravitySkillNamesFromToolCall(
  toolName: string,
  inputJson: string | null,
  options?: { cwd?: string | null; extraRoots?: readonly string[] },
): string[] {
  if (!inputJson || !inputJson.includes('SKILL.md')) return [];

  if (ANTIGRAVITY_FILE_READ_TOOLS.has(toolName)) {
    const rawPath = extractAntigravityFileReadPath(inputJson);
    if (!rawPath) return [];
    const skillName = extractSkillNameFromPath(rawPath, options);
    return skillName ? [skillName] : [];
  }

  if (ANTIGRAVITY_SHELL_TOOLS.has(toolName)) {
    const command = extractCodexCommandFromInputJson(inputJson);
    if (!command) return [];
    const readSegments = extractFileReadSegmentTokens(command);
    if (readSegments.length === 0) return [];
    const skillNames = new Set<string>();
    for (const tokens of readSegments) {
      for (const { fullPath } of extractSkillPathMatches(tokens)) {
        const skillName = extractSkillNameFromPath(fullPath, options);
        if (skillName) skillNames.add(skillName);
      }
    }
    return [...skillNames];
  }

  return [];
}

export function fingerprintAntigravitySkillCall(
  toolName: string,
  inputJson: string | null,
  options?: { cwd?: string | null },
): string | null {
  if (ANTIGRAVITY_FILE_READ_TOOLS.has(toolName)) {
    const rawPath = extractAntigravityFileReadPath(inputJson);
    if (!rawPath) return null;
    const normalized = toNormalizedPosixPath(rawPath, options?.cwd) ?? rawPath;
    return createHash('sha256').update(`${toolName}\0${normalized}`, 'utf8').digest('hex');
  }
  if (ANTIGRAVITY_SHELL_TOOLS.has(toolName)) {
    const command = extractCodexCommandFromInputJson(inputJson);
    return command ? fingerprintCodexCommand(command) : null;
  }
  return null;
}

export function fingerprintCodexCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}
