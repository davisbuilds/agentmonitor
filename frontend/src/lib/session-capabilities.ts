import type { SessionCapabilities, SessionCapabilityLevel } from './api/client';

export type SessionCapabilityKey = keyof SessionCapabilities;
export type CapabilitySummaryTone = 'full' | 'summary' | 'mixed' | 'unknown';

export interface SessionCapabilityEntry {
  key: SessionCapabilityKey;
  label: string;
  shortLabel: string;
  level: SessionCapabilityLevel;
}

export interface SessionCapabilitySummary {
  label: string;
  description: string;
  tone: CapabilitySummaryTone;
}

const CAPABILITY_ORDER: SessionCapabilityKey[] = ['history', 'search', 'tool_analytics', 'live_items'];

const CAPABILITY_LABELS: Record<SessionCapabilityKey, { label: string; shortLabel: string }> = {
  history: { label: 'History', shortLabel: 'Hist' },
  search: { label: 'Search', shortLabel: 'Search' },
  tool_analytics: { label: 'Tool Analytics', shortLabel: 'Tools' },
  live_items: { label: 'Live Items', shortLabel: 'Live' },
};

const LEVEL_RANK: Record<SessionCapabilityLevel, number> = {
  none: 0,
  summary: 1,
  full: 2,
};

export function capabilityLevelText(level: SessionCapabilityLevel): string {
  switch (level) {
    case 'full':
      return 'full';
    case 'summary':
      return 'summary';
    default:
      return 'off';
  }
}

export function getCapabilityEntries(capabilities: SessionCapabilities | null): SessionCapabilityEntry[] {
  if (!capabilities) return [];

  return CAPABILITY_ORDER.map((key) => ({
    key,
    label: CAPABILITY_LABELS[key].label,
    shortLabel: CAPABILITY_LABELS[key].shortLabel,
    level: capabilities[key],
  }));
}

export function hasSessionCapability(
  capabilities: SessionCapabilities | null,
  key: SessionCapabilityKey,
  minimum: SessionCapabilityLevel = 'summary',
): boolean {
  if (!capabilities) return false;
  return LEVEL_RANK[capabilities[key]] >= LEVEL_RANK[minimum];
}

export function summarizeCapabilities(capabilities: SessionCapabilities | null): SessionCapabilitySummary {
  if (!capabilities) {
    return {
      label: 'capabilities unknown',
      description: 'This session did not report a projection capability contract.',
      tone: 'unknown',
    };
  }

  const levels = CAPABILITY_ORDER.map((key) => capabilities[key]);
  if (levels.every((level) => level === 'full')) {
    return {
      label: 'full surface',
      description: 'History, search, tool analytics, and live items are all available.',
      tone: 'full',
    };
  }

  if (
    capabilities.live_items !== 'none'
    && capabilities.history === 'none'
    && capabilities.search === 'none'
    && capabilities.tool_analytics === 'none'
  ) {
    return {
      label: capabilities.live_items === 'full' ? 'live surface only' : 'live summary only',
      description: 'Live items are available, but transcript history, search, and tool analytics are not.',
      tone: 'summary',
    };
  }

  const available = CAPABILITY_ORDER
    .filter((key) => capabilities[key] !== 'none')
    .map((key) => CAPABILITY_LABELS[key].label.toLowerCase());
  const missing = CAPABILITY_ORDER
    .filter((key) => capabilities[key] === 'none')
    .map((key) => CAPABILITY_LABELS[key].label.toLowerCase());

  return {
    label: 'partial surface',
    description: `Available: ${available.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`,
    tone: 'mixed',
  };
}
