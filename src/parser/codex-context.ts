import path from 'node:path';
import {
  catalogFingerprint,
  codexCatalogBlocks,
  codexCheckpointMatches,
  codexRecord,
  CODEX_CATALOG_SOURCE_ENTRIES,
  isAbsoluteCatalogPath,
  readCodexCatalog,
  type CatalogBlock,
} from '../skills/codex-catalog.js';
import {
  projectIdentityFromCwd,
  type CatalogObservationEntry,
  type CodexCatalogSource,
  type CodexCatalogSourceState,
  type ObservationCapability,
  type SessionContextObservation,
} from '../skills/context-observations.js';

const MAX_HISTORY = 4_096;
const MAX_CATALOG_HISTORY_ENTRIES = 16_384;
const SOURCES: CodexCatalogSource[] = ['host', 'cloud', 'selected-environment', 'legacy'];

interface SourceState {
  state: CodexCatalogSourceState;
  roots: ReadonlyMap<string, string>;
}

export interface CodexContextParseState {
  catalogSources: Map<CodexCatalogSource, SourceState>;
  historyCount: number;
  entryCount: number;
  hasPresentation: boolean;
  hasInstructionObservation: boolean;
  instructionCoverage?: ObservationCapability;
  diagnostics: Set<string>;
  startup: boolean;
  sawCatalog: boolean;
  build: string | null;
  sessionId: string | undefined;
}

interface PendingPresentation {
  block: CatalogBlock;
  ordinal: number;
  timestamp: string | null;
  turnId: string | null;
  startupLegacy: boolean;
  build: string | null;
  freshCompaction: boolean;
  checkpointMatched: boolean;
}

interface ContextRecord {
  type?: string;
  payload?: unknown;
  timestamp?: string;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= 4_096 ? value.trim() : null;
}

function date(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function locatorKey(entry: CatalogObservationEntry): string | null {
  return entry.sourceLocation === null ? null : (entry.scope ?? '') + '\0' + entry.sourceLocation;
}

function applyDelta(base: CatalogObservationEntry[], additions: CatalogObservationEntry[]): CatalogObservationEntry[] | null {
  const effective = [...base];
  const locators = new Map<string | null, number>();
  const names = new Set(base.map(entry => entry.name));
  for (const [index, entry] of base.entries()) {
    const key = locatorKey(entry);
    locators.set(key, locators.has(key) ? -1 : index);
  }
  const updated = new Set<string>();
  for (const entry of additions) {
    const key = locatorKey(entry);
    if (!key || updated.has(key)) return null;
    updated.add(key);
    const position = locators.get(key);
    if (position === -1 || (position === undefined && names.has(entry.name))) return null;
    if (position === undefined) effective.push(entry);
    else effective[position] = entry;
  }
  return effective.length <= CODEX_CATALOG_SOURCE_ENTRIES ? effective : null;
}

export class CodexContextParser {
  readonly observations: SessionContextObservation[] = [];
  readonly state: CodexContextParseState;
  resumable = true;
  private pending: PendingPresentation[] = [];

  constructor(state: CodexContextParseState | undefined) {
    this.state = state
      ? { ...state, catalogSources: new Map(state.catalogSources), diagnostics: new Set(state.diagnostics) }
      : {
          catalogSources: new Map(), historyCount: 0, entryCount: 0,
          hasPresentation: false, hasInstructionObservation: false, diagnostics: new Set(),
          startup: true, sawCatalog: false, build: null, sessionId: undefined,
        };
  }

  emit(observation: SessionContextObservation): boolean {
    const entries = observation.catalogEntries?.length ?? 0;
    if (this.state.historyCount >= MAX_HISTORY || this.state.entryCount + entries > MAX_CATALOG_HISTORY_ENTRIES) {
      this.state.diagnostics.add('context_history_limit');
      return false;
    }
    this.state.historyCount++;
    this.state.entryCount += entries;
    this.observations.push(observation);
    return true;
  }

  finish(): void {
    if (this.pending.length) {
      this.resumable = false;
      this.resolvePending(null);
    }
  }

  inspect(line: ContextRecord, ordinal: number, cwd: string | null, inherited: boolean, next: ContextRecord | undefined): void {
    const payload = codexRecord(line.payload);
    const timestamp = date(line.timestamp);
    switch (line.type) {
      case 'session_meta': {
        this.resolvePending(null);
        const owner = payload?.['id'];
        if (!this.state.sessionId || owner === this.state.sessionId) {
          this.state.sessionId = typeof owner === 'string' ? owner : this.state.sessionId;
          this.state.build = string(payload?.['cli_version']);
          this.state.startup = true;
          this.state.sawCatalog = false;
        }
        return;
      }
      case 'turn_context': {
        const window = codexRecord(codexRecord(next?.payload)?.['info'])?.['model_context_window'];
        const contextCwd = string(payload?.['cwd']);
        const model = string(payload?.['model']);
        const turnId = string(payload?.['turn_id']);
        const windowTurn = string(codexRecord(next?.payload)?.['turn_id']);
        const windowReported = next?.type === 'event_msg' && codexRecord(next.payload)?.['type'] === 'token_count'
          && (!turnId || !windowTurn || turnId === windowTurn)
          && typeof window === 'number' && Number.isSafeInteger(window) && window > 0
          ? window : null;
        if (this.pending.length && !next && contextCwd && model) this.resumable = false;
        this.resolvePending(contextCwd && isAbsoluteCatalogPath(contextCwd) && model
          ? { cwd: contextCwd, model, turnId, window: windowReported }
          : null, false);
        this.state.startup = false;
        return;
      }
      case 'compacted': {
        this.resolvePending(null, false);
        this.emit({ ordinal, kind: 'compaction', source: 'codex_compacted', timestamp,
          projectIdentity: projectIdentityFromCwd(cwd) ?? undefined });
        if (payload) this.compact(payload, ordinal, timestamp);
        else this.invalidate(null, 'catalog_compaction_unverified', timestamp, null);
        this.state.startup = false;
        return;
      }
      case 'world_state': {
        if (payload) {
          for (const entry of this.pending) {
            if (entry.freshCompaction && payload['full'] === true) {
              const checkpointTurnId = string(payload['turn_id']);
              entry.checkpointMatched = (!entry.turnId || !checkpointTurnId || entry.turnId === checkpointTurnId)
                && codexCheckpointMatches(payload, entry.block);
            }
          }
          this.inspectInstructions(payload, ordinal, timestamp, cwd);
        }
        return;
      }
      case 'event_msg': {
        const type = payload?.['type'];
        if (type === 'thread_rolled_back') {
          this.resolvePending(null, false);
          this.invalidate(null, 'catalog_rollback', timestamp, null);
          this.state.startup = false;
        } else if (type === 'user_message' || type === 'task_started' || type === 'task_complete' || type === 'turn_aborted'
          || type === 'turn_started' || type === 'turn_completed') {
          this.resolvePending(null, false);
          this.state.startup = false;
        }
        return;
      }
      case 'response_item': {
        if (!payload) return;
        if (payload['role'] === 'user' || payload['role'] === 'assistant' || payload['role'] === 'tool'
          || ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(String(payload['type']))
          || typeof payload['name'] === 'string') {
          this.resolvePending(null);
          this.state.startup = false;
          return;
        }
        const blocks = codexCatalogBlocks(payload);
        if (blocks.length > SOURCES.length) {
          this.resolvePending(null, false);
          this.invalidate(null, 'catalog_payload_limit', timestamp, null);
          return;
        }
        for (const [index, block] of blocks.entries()) {
          const turnId = string(payload['turn_id']);
          if (!block.source || this.pending.some(candidate => candidate.freshCompaction
            || (!block.unsupported && candidate.block.source === block.source)
            || (turnId && candidate.turnId && turnId !== candidate.turnId))) {
            this.resolvePending(null, false);
          }
          const startup = this.state.startup && !this.state.sawCatalog && !inherited;
          if (block.unsupported || !block.source) {
            this.pending = this.pending.filter(candidate => candidate.block.source !== block.source);
            this.invalidate(block.source, block.unsupported ?? 'catalog_format_unsupported', timestamp, null);
          } else {
            this.pending.push({
              block, ordinal: ordinal + index, timestamp, turnId,
              startupLegacy: startup && block.source === 'legacy' && block.kind === 'full',
              build: startup ? this.state.build : null,
              freshCompaction: false, checkpointMatched: false,
            });
          }
          this.state.sawCatalog = true;
        }
        return;
      }
      case 'malformed_source_record': {
        this.resolvePending(null, false);
        this.invalidate(null, 'malformed_source_record', null, null, false);
        this.state.startup = false;
      }
    }
  }

  private resolvePending(
    context: { cwd: string; model: string; turnId: string | null; window: number | null } | null,
    allowLegacyStartup = true,
  ): void {
    for (const pending of this.pending) {
      const source = pending.block.source!;
      const scoped = context && (!context.turnId || !pending.turnId || context.turnId === pending.turnId) ? context : null;
      if (pending.freshCompaction && !pending.checkpointMatched) {
        this.invalidate(source, 'catalog_compaction_unverified', pending.timestamp, null);
        continue;
      }
      const legacyStartup = pending.startupLegacy && allowLegacyStartup;
      if (!scoped && !legacyStartup) {
        this.invalidate(source, 'catalog_turn_context_unavailable', pending.timestamp, null);
        continue;
      }
      if (!pending.timestamp && !legacyStartup) {
        this.invalidate(source, 'catalog_timestamp_unavailable', null, projectIdentityFromCwd(scoped?.cwd));
        continue;
      }
      this.apply(pending, scoped);
    }
    this.pending = [];
  }

  private apply(
    pending: PendingPresentation,
    context: { cwd: string; model: string; window: number | null } | null,
  ): void {
    const { block, timestamp, ordinal, build } = pending;
    const source = block.source!;
    const projectIdentity = projectIdentityFromCwd(context?.cwd);
    const prior = this.state.catalogSources.get(source);
    if (block.kind === 'delta' && prior?.state.status !== 'observed') {
      this.invalidate(source, 'catalog_delta_without_base', timestamp, projectIdentity);
      return;
    }
    const listing = readCodexCatalog(block, prior?.roots);
    const effective = listing && (block.kind === 'delta' && prior?.state.status === 'observed'
      ? applyDelta(prior.state.entries, listing.entries)
      : listing.entries);
    if (!listing || !effective) {
      this.invalidate(source, 'catalog_format_unsupported', timestamp, projectIdentity);
      return;
    }
    const emitted = this.emit({
      ordinal, timestamp, kind: 'catalog_presentation',
      source: pending.freshCompaction ? 'codex_compaction_checkpoint' : 'codex_response_item',
      projectIdentity: projectIdentity ?? undefined,
      catalogEntries: listing.entries,
      metadata: {
        catalogSource: source,
        catalogKind: block.kind,
        scope: source === 'legacy' ? 'harness' : 'source',
        fingerprint: catalogFingerprint(listing.entries),
        measurement: { value: Buffer.byteLength(block.text), unit: 'utf8_bytes', method: 'retained_catalog_block_utf8_bytes/v1' },
        truncation: listing.truncation,
        runtime: {
          harnessVersion: build, model: context?.model ?? null, modelVersion: null,
          contextWindowIdentity: context?.window == null ? null : 'tokens:' + context.window,
          representation: listing.representation,
        },
      },
    });
    if (!emitted) {
      this.invalidate(source, 'context_history_limit', timestamp, projectIdentity);
      return;
    }
    this.state.hasPresentation = true;
    if (listing.truncation === 'observed') {
      this.invalidate(source, 'catalog_truncation_observed', timestamp, projectIdentity);
      return;
    }
    this.state.catalogSources.set(source, {
      state: { source, status: 'observed', basis: block.kind, entries: effective, observedAt: timestamp, projectIdentity },
      roots: listing.roots,
    });
  }

  private invalidate(
    source: CodexCatalogSource | null,
    reason: string,
    observedAt: string | null,
    projectIdentity: string | null,
    createUnknownWhenEmpty = true,
  ): void {
    const affected = source ? [source] : [...this.state.catalogSources.keys()];
    if (!affected.length && createUnknownWhenEmpty) affected.push(...SOURCES);
    if (affected.length) this.state.diagnostics.add(reason);
    for (const affectedSource of affected) {
      this.state.catalogSources.set(affectedSource, {
        state: { source: affectedSource, status: 'unknown', reason, observedAt, projectIdentity },
        roots: new Map(),
      });
    }
  }

  private compact(payload: Record<string, unknown>, ordinal: number, timestamp: string | null): void {
    const history = payload['replacement_history'];
    const metadata = payload['replacement_history_metadata'];
    if (!Array.isArray(history)) {
      this.invalidate(null, 'catalog_compaction_unverified', timestamp, null, false);
      return;
    }
    if (history.length > MAX_HISTORY) {
      this.invalidate(null, 'catalog_payload_limit', timestamp, null);
      return;
    }
    const replacements = new Map<CodexCatalogSource, PendingPresentation>();
    const aligned = Array.isArray(metadata) && metadata.length === history.length;
    for (const [index, item] of history.entries()) {
      const record = codexRecord(item);
      const response = record?.['type'] === 'response_item' ? codexRecord(record['payload']) : record;
      if (!response) continue;
      for (const block of codexCatalogBlocks(response)) {
        if (!block.source) {
          this.invalidate(null, 'catalog_compaction_unverified', timestamp, null);
          this.pending = [];
          return;
        }
        const exact = aligned ? codexRecord(metadata[index]) : undefined;
        const isFresh = exact !== undefined && !Object.hasOwn(exact, 'history_sequence')
          && block.typed && block.kind === 'full' && !block.unsupported;
        const source = block.source;
        const first = !replacements.has(source);
        replacements.set(source, {
          block, ordinal: ordinal + replacements.size + 1, timestamp, turnId: string(payload['turn_id']),
          startupLegacy: false, build: null, freshCompaction: isFresh && first, checkpointMatched: false,
        });
      }
    }
    for (const source of new Set([...this.state.catalogSources.keys(), ...replacements.keys()])) {
      const replacement = replacements.get(source);
      const prior = this.state.catalogSources.get(source);
      const listing = replacement?.block.kind === 'full' ? readCodexCatalog(replacement.block) : null;
      if (listing && listing.truncation !== 'observed' && prior?.state.status === 'observed'
        && listing.roots.size === prior.roots.size
        && [...listing.roots].every(([alias, locator]) => prior.roots.get(alias) === locator)
        && catalogFingerprint(listing.entries) === catalogFingerprint(prior.state.entries)) continue;
      this.invalidate(source, 'catalog_compaction_unverified', timestamp, null);
      if (replacement?.freshCompaction && listing) this.pending.push(replacement);
    }
  }

  private inspectInstructions(payload: Record<string, unknown>, ordinal: number, timestamp: string | null, cwd: string | null): void {
    const state = codexRecord(payload['state']);
    if (!state || !Object.hasOwn(state, 'agents_md')) return;
    const value = state['agents_md'];
    const agents = Array.isArray(value) ? value : [value];
    if (agents.length > MAX_HISTORY) {
      this.state.diagnostics.add('instruction_payload_limit');
      this.state.instructionCoverage = { observable: false, reason: 'instruction_payload_limit' };
      return;
    }
    const empty = payload['full'] === true && (value === null || agents.length === 0);
    let supported = empty;
    for (const agent of agents) {
      const record = codexRecord(agent);
      const directory = string(record?.['directory']);
      const text = typeof agent === 'string' ? agent : record?.['text'];
      const filePath = directory && isAbsoluteCatalogPath(directory)
        ? (directory.startsWith('/') ? path.posix : path.win32).join(directory, 'AGENTS.md') : null;
      if (!filePath && (typeof text !== 'string' || !text.trim())) continue;
      if (this.emit({
        ordinal, timestamp, kind: 'instruction_load', source: 'codex_world_state',
        projectIdentity: projectIdentityFromCwd(cwd) ?? undefined,
        metadata: {
          file_path: filePath, memory_type: 'AGENTS.md',
          ...(filePath ? {} : { load_reason: 'instruction_file_identity_unavailable' }),
        },
      })) {
        this.state.hasInstructionObservation = true;
        supported = true;
      }
    }
    this.state.instructionCoverage = supported
      ? { observable: true } : { observable: false, reason: 'instruction_signal_unsupported' };
    if (!supported) this.state.diagnostics.add('instruction_signal_unsupported');
  }
}
