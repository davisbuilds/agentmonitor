import { createHash } from 'node:crypto';
import path from 'node:path';

export type SessionContextObservationKind =
  | 'consultation'
  | 'compaction'
  | 'catalog_presentation'
  | 'instruction_load';

export interface CatalogObservationEntry {
  name: string;
  description: string | null;
  descriptionFingerprint: string | null;
  sourceLocation: string | null;
  scope: string | null;
}

export type CodexCatalogSource = 'host' | 'cloud' | 'selected-environment' | 'legacy';

interface CodexCatalogSourcePosition {
  source: CodexCatalogSource;
  observedAt: string | null;
  projectIdentity: string | null;
}

export type CodexCatalogSourceState = CodexCatalogSourcePosition & (
  | { status: 'observed'; entries: CatalogObservationEntry[]; basis: 'full' | 'delta' }
  | { status: 'unknown'; reason: string }
);

export interface SessionContextObservation {
  ordinal: number;
  kind: SessionContextObservationKind;
  source: string;
  timestamp: string | null;
  skillName?: string;
  commandFingerprint?: string;
  projectIdentity?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  catalogEntries?: CatalogObservationEntry[];
}

export interface ObservationCapability {
  observable: boolean;
  reason?: string;
}

export interface SkillContextCapabilities {
  orderedConsultations: ObservationCapability;
  compactionVisibility: ObservationCapability;
  catalogPresentation: ObservationCapability;
  instructionLoads: ObservationCapability;
  diagnostics: string[];
  codexEvidenceVersion?: number;
  codexCatalogSources?: CodexCatalogSourceState[];
}

export interface ParsedSkillContext {
  projectIdentity: string | null;
  observations: SessionContextObservation[];
  capabilities: SkillContextCapabilities;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectIdentityFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd?.trim()) return null;
  const normalized = path.posix.normalize(cwd.trim().replaceAll('\\', '/'));
  return `cwd:${sha256(normalized)}`;
}

export function unavailableSkillContext(reason = 'harness_signal_unavailable'): ParsedSkillContext {
  const unavailable = (): ObservationCapability => ({ observable: false, reason });
  return {
    projectIdentity: null,
    observations: [],
    capabilities: {
      orderedConsultations: unavailable(),
      compactionVisibility: unavailable(),
      catalogPresentation: unavailable(),
      instructionLoads: unavailable(),
      diagnostics: [],
    },
  };
}
