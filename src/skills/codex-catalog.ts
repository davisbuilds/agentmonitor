import { createHash } from 'node:crypto';
import type { CatalogObservationEntry, CodexCatalogSource } from './context-observations.js';

const CATALOG_BYTES = 512 * 1024;
export const CODEX_CATALOG_SOURCE_ENTRIES = 2_048;
const ROOT_LIMIT = 128;
const TAG = '<skills_instructions';
const CLOSE = '</skills_instructions>';
const ROOT_HEADER = '### Skill roots';
const AVAILABLE_HEADER = '### Available skills';
const UPDATE_HEADER = '### Added or updated skills:';
const UPDATE_ROOT_NOTICE = 'These mappings replace earlier mappings for the same aliases.';
const ROOT_LINE = /^- `([A-Za-z0-9_]+)` = `([^`]+)`$/;
const ENTRY = /^- ([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*):(?: (.*?))? \(([a-z ]+): (.+)\)$/;
const SOURCES = new Map<string, CodexCatalogSource>([
  ['Host skills', 'host'],
  ['Cloud skills', 'cloud'],
  ['Selected-environment skills', 'selected-environment'],
]);
const CONTENT_KINDS = new Map<string, CodexCatalogSource>([
  ['host_skills.instructions', 'host'],
  ['cloud_skills.instructions', 'cloud'],
  ['skills.instructions', 'selected-environment'],
  ['skills.catalog', 'host'],
]);
const SNAPSHOT_KEYS = {
  host: 'host_skills',
  cloud: 'cloud_skills',
  'selected-environment': 'skills',
};

export interface CatalogBlock {
  text: string;
  source: CodexCatalogSource | null;
  kind: 'full' | 'delta';
  typed: boolean;
  unsupported?: 'catalog_payload_limit' | 'catalog_format_unsupported';
}

export interface CatalogListing {
  entries: CatalogObservationEntry[];
  roots: ReadonlyMap<string, string>;
  representation: 'skills_instructions_xml' | 'skills_instructions_markdown';
  truncation: 'observed' | 'not_observed' | 'unknown';
}

export function codexRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function at(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

function headingSource(body: string): { source?: CodexCatalogSource; kind: 'full' | 'delta' } {
  const heading = body.trimStart().split('\n', 1)[0]?.trim();
  const label = heading?.startsWith('## ') ? heading.slice(3) : '';
  const update = label.endsWith(' update');
  return { source: SOURCES.get(update ? label.slice(0, -7) : label), kind: update ? 'delta' : 'full' };
}

function bodyOf(text: string): string | undefined {
  const start = /^<skills_instructions(?:\s[^>]*)?>/.exec(text);
  if (!start || !text.endsWith(CLOSE)) return;
  const body = text.slice(start[0].length, -CLOSE.length);
  if (!body.includes(CLOSE) && !body.includes(TAG)) return body;
}

function classifyBlock(raw: string, typed: boolean, contentSource: CodexCatalogSource | undefined): CatalogBlock | null {
  const text = raw.trim();
  if (!text.startsWith(TAG) && !typed && !contentSource) return null;
  const open = text.indexOf('>');
  const heading = headingSource(text.slice(open + 1));
  const source = contentSource ?? heading.source ?? (typed ? null : 'legacy');
  const block: CatalogBlock = { source, text, kind: heading.kind, typed };
  if (Buffer.byteLength(text) > CATALOG_BYTES) {
    return { ...block, text: '', unsupported: 'catalog_payload_limit' };
  }
  if ((heading.source && contentSource && heading.source !== contentSource)
    || !bodyOf(text) || (heading.kind === 'delta' && (!source || source === 'legacy'))) {
    return { ...block, text: '', unsupported: 'catalog_format_unsupported' };
  }
  return block;
}

export function codexCatalogBlocks(payload: Record<string, unknown>): CatalogBlock[] {
  if (payload['role'] !== 'developer' || (payload['type'] !== 'message' && payload['type'] !== undefined)) return [];
  const content = payload['content'];
  if (!Array.isArray(content)) return [];
  const metadata = codexRecord(payload['internal_chat_message_metadata_passthrough']);
  const blocks: CatalogBlock[] = [];
  let fragments = '';
  let fragmented = false;
  const emit = (raw: string, typed: boolean, source: CodexCatalogSource | undefined): void => {
    const block = classifyBlock(raw, typed, source);
    if (block) blocks.push(block);
  };
  const flush = (): void => {
    if (fragmented) emit(fragments, false, undefined);
    fragments = '';
    fragmented = false;
  };
  for (const [index, value] of content.entries()) {
    if (blocks.length > 4) return blocks;
    const item = codexRecord(value);
    const kind = at(metadata?.['content_item_kinds'], index);
    const itemMetadata = codexRecord(at(metadata?.['content_item_metadata'], index));
    const provenance = codexRecord(itemMetadata?.['provenance'])?.['type'];
    const contentSource = typeof kind === 'string' ? CONTENT_KINDS.get(kind) : undefined;
    if ((provenance != null && provenance !== 'skills' && provenance !== 'unknown')
      || (kind != null && !contentSource && provenance !== 'skills')) {
      flush();
      continue;
    }
    const text = item?.['type'] === 'input_text' && typeof item['text'] === 'string' ? item['text'] : '';
    if (metadata || !text) {
      flush();
      emit(text, provenance === 'skills', contentSource);
      continue;
    }

    const trimmed = text.trimStart();
    if (fragmented && trimmed.startsWith(TAG)) flush();
    if (fragmented || (trimmed && TAG.startsWith(trimmed)) || (trimmed.startsWith(TAG) && !trimmed.includes(CLOSE))) {
      fragmented = true;
      fragments += text;
      if (fragments.includes(CLOSE) || Buffer.byteLength(fragments) > CATALOG_BYTES) flush();
    } else {
      emit(text, false, undefined);
    }
  }
  flush();
  return blocks;
}

function xmlValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return match ? (match[1] ?? '').trim()
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&') : null;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function entry(name: string, description: string | null, sourceLocation: string | null, scope: string | null): CatalogObservationEntry {
  return { name, description, sourceLocation, scope, descriptionFingerprint: description === null ? null : hash(description) };
}

function readXml(body: string): CatalogObservationEntry[] | null {
  const wrapper = /^<skills(?:\s[^>]*)?>([\s\S]*?)<\/skills>$/.exec(body.trim());
  if (!wrapper) return null;
  const content = wrapper[1] ?? '';
  const pattern = /<skill>([\s\S]*?)<\/skill>/g;
  if (content.replace(pattern, '').trim()) return null;
  const entries: CatalogObservationEntry[] = [];
  for (const match of content.matchAll(pattern)) {
    const row = match[1] ?? '';
    const name = xmlValue(row, 'name');
    if (!name || /[\s<>]/.test(name) || entries.length === CODEX_CATALOG_SOURCE_ENTRIES) return null;
    if (row.replace(/<(name|description|location|scope)>[\s\S]*?<\/\1>/g, '').trim()) return null;
    entries.push(entry(name, xmlValue(row, 'description'), xmlValue(row, 'location'), xmlValue(row, 'scope')));
  }
  return entries;
}

export function isAbsoluteCatalogPath(value: string): boolean {
  return !value.includes('\0') && (value.startsWith('/') || /^[A-Za-z]:[/\\]/.test(value));
}

function resolveLocator(kind: string, locator: string, roots: ReadonlyMap<string, string>): string | null {
  const boundary = locator.indexOf('/');
  const root = boundary > 0 ? roots.get(locator.slice(0, boundary)) : null;
  const resolved = root ? root.replace(/\/$/, '') + locator.slice(boundary) : locator;
  if ((kind === 'file' && !isAbsoluteCatalogPath(resolved)) || (!root && /^[rc]\d+\//.test(locator))) return null;
  return resolved;
}

function wrapperTruncation(text: string): CatalogListing['truncation'] {
  const wrapper = text.slice(0, text.indexOf('>'));
  const field = /\struncat(?:ed|ion)\s*=\s*(['"]?)(true|yes|1|false|no|0)\1(?=\s|$)/i.exec(wrapper);
  if (!field) return 'unknown';
  return /^(true|yes|1)$/i.test(field[2] ?? '') ? 'observed' : 'not_observed';
}

function readMarkdown(body: string, block: CatalogBlock, previousRoots: ReadonlyMap<string, string>): CatalogListing | null {
  const lines = body.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const roots = new Map(block.kind === 'delta' ? previousRoots : []);
  const declared = new Set<string>();
  const heading = lines[0]?.startsWith('## ') ? lines.shift()?.slice(3) : undefined;
  if (heading && !headingSource('## ' + heading).source && heading !== 'Skills') return null;
  if (!heading && block.source !== 'legacy') return null;
  const entries: CatalogObservationEntry[] = [];
  let section: 'intro' | 'roots' | 'entries' = 'intro';
  let sawEntries = false;
  let truncation = wrapperTruncation(block.text);
  for (const [index, line] of lines.entries()) {
    if (line === ROOT_HEADER && section === 'intro') {
      if (block.kind === 'delta' && lines[index + 1] !== UPDATE_ROOT_NOTICE) return null;
      section = 'roots';
      continue;
    }
    if (section === 'roots' && line === UPDATE_ROOT_NOTICE && block.kind === 'delta' && lines[index - 1] === ROOT_HEADER) continue;
    if ((line === (block.kind === 'delta' ? UPDATE_HEADER : AVAILABLE_HEADER)
      || (block.kind === 'full' && line === AVAILABLE_HEADER + ':')) && !sawEntries) {
      if (section === 'roots' && declared.size === 0) return null;
      section = 'entries';
      sawEntries = true;
      continue;
    }
    if (section === 'roots') {
      const match = ROOT_LINE.exec(line);
      const alias = match?.[1];
      const locator = match?.[2];
      if (!alias || !locator || declared.has(alias)) return null;
      declared.add(alias);
      roots.set(alias, locator);
      if (roots.size > ROOT_LIMIT) return null;
      continue;
    }
    if (section === 'intro' && !line.startsWith('#') && !line.startsWith('-') && block.kind === 'full') {
      if (block.source === 'legacy' && /^available skills\s*:\s*(?:none|\[\])$/i.test(line)) sawEntries = true;
      continue;
    }
    if (section === 'entries' && block.kind === 'full'
      && /^(Exceeded skills context budget|Skill descriptions were shortened)/.test(line)) {
      truncation = 'observed';
      continue;
    }
    if (section === 'intro' && block.source === 'legacy' && line.startsWith('- ')) {
      section = 'entries';
      sawEntries = true;
    }
    if (section !== 'entries') return null;
    const match = ENTRY.exec(line);
    if (!match || entries.length === CODEX_CATALOG_SOURCE_ENTRIES) return null;
    const kind = match[3]!;
    const locator = resolveLocator(kind, match[4]!, roots);
    if (!locator) return null;
    entries.push(entry(match[1]!, match[2]?.trim() || null, locator, kind === 'file' ? null : kind));
  }
  if (!sawEntries || (block.kind === 'delta' && entries.length === 0)) return null;
  return { entries, roots, representation: 'skills_instructions_markdown', truncation };
}

export function readCodexCatalog(block: CatalogBlock, previousRoots: ReadonlyMap<string, string> = new Map()): CatalogListing | null {
  if (block.unsupported) return null;
  const body = bodyOf(block.text);
  if (body === undefined) return null;
  if (body.trimStart().startsWith('<skills')) {
    if (block.kind !== 'full') return null;
    const entries = readXml(body);
    return entries
      ? { entries, roots: new Map(), representation: 'skills_instructions_xml', truncation: wrapperTruncation(block.text) }
      : null;
  }
  return readMarkdown(body, block, previousRoots);
}

export function catalogFingerprint(entries: CatalogObservationEntry[]): string {
  return hash(JSON.stringify(entries.map((row, ordinal) => ({
    ordinal, name: row.name, description: row.description, sourceLocation: row.sourceLocation, sourceScope: row.scope,
  }))));
}

export function codexCheckpointMatches(payload: Record<string, unknown>, block: CatalogBlock): boolean {
  if (payload['full'] !== true || !block.source || block.source === 'legacy') return false;
  const body = bodyOf(block.text);
  const state = codexRecord(payload['state']);
  const source = codexRecord(state?.[SNAPSHOT_KEYS[block.source]]);
  const checkpointBody = source?.['body'];
  return body !== undefined && source?.['includeInstructions'] === true
    && typeof checkpointBody === 'string' && body.trim() === checkpointBody.trim();
}
