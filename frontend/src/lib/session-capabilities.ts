import type { SessionCapabilities, SessionCapabilityLevel } from './api/client';

export type SessionCapabilityKey = keyof SessionCapabilities;
export type CoverageTone = 'ok' | 'warn' | 'accent' | 'neutral';

export interface SessionCapabilityEntry {
  key: SessionCapabilityKey;
  label: string;
  level: SessionCapabilityLevel;
}

/** How much of a session amon can show, in a word or two. */
export interface SessionCoverage {
  label: string;
  tone: CoverageTone;
  /** Everything is available at full detail; lists say nothing about it. */
  full: boolean;
}

const CAPABILITY_ORDER: SessionCapabilityKey[] = ['history', 'search', 'tool_analytics', 'live_items'];

const CAPABILITY_LABELS: Record<SessionCapabilityKey, string> = {
  history: 'Transcript',
  search: 'Search',
  tool_analytics: 'Tool analytics',
  live_items: 'Live stream',
};

const LEVEL_RANK: Record<SessionCapabilityLevel, number> = {
  none: 0,
  summary: 1,
  full: 2,
};

export function capabilityLevelLabel(level: SessionCapabilityLevel): string {
  switch (level) {
    case 'full': return 'Full';
    case 'summary': return 'Summary';
    default: return 'Not available';
  }
}

export function getCapabilityEntries(capabilities: SessionCapabilities | null): SessionCapabilityEntry[] {
  if (!capabilities) return [];
  return CAPABILITY_ORDER.map((key) => ({ key, label: CAPABILITY_LABELS[key], level: capabilities[key] }));
}

export function hasSessionCapability(
  capabilities: SessionCapabilities | null,
  key: SessionCapabilityKey,
  minimum: SessionCapabilityLevel = 'summary',
): boolean {
  if (!capabilities) return false;
  return LEVEL_RANK[capabilities[key]] >= LEVEL_RANK[minimum];
}

export function describeCoverage(capabilities: SessionCapabilities | null): SessionCoverage {
  if (!capabilities) return { label: 'Detail unknown', tone: 'neutral', full: false };
  const levels = CAPABILITY_ORDER.map((key) => capabilities[key]);
  if (levels.every((level) => level === 'full')) return { label: 'Full detail', tone: 'ok', full: true };
  const available = CAPABILITY_ORDER.filter((key) => capabilities[key] !== 'none');
  if (available.length === 0) return { label: 'No detail', tone: 'neutral', full: false };
  if (available.length === 1 && available[0] === 'live_items') {
    return { label: 'Live activity only', tone: 'warn', full: false };
  }
  if (available.length > 0 && available.every((key) => capabilities[key] === 'summary')) {
    return { label: 'Summary detail', tone: 'warn', full: false };
  }
  return { label: 'Partial detail', tone: 'accent', full: false };
}

const SOURCE_LABELS: Record<string, string> = {
  'claude-jsonl': 'Claude Code transcript',
  'codex-jsonl': 'Codex rollout file',
  'codex-otel': 'Codex telemetry',
  'codex-import': 'Codex history import',
  'codex-summary': 'Codex summary',
  'antigravity-sqlite': 'Antigravity',
  'antigravity-cli': 'Antigravity',
};

/** Where a session's data came from, in words rather than its integration mode. */
export function sessionSourceLabel(integrationMode: string | null | undefined): string {
  if (!integrationMode) return 'Unknown source';
  return SOURCE_LABELS[integrationMode] ?? integrationMode;
}
