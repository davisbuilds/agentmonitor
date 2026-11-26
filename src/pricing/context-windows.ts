
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const CODEX_DEFAULT_CONTEXT_WINDOW = 256_000;
export const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 1_048_576;

const WINDOW_TIERS = [200_000, 256_000, 400_000, 1_000_000, 1_048_576, 2_000_000] as const;

function isClaudeAgent(agent: string): boolean {
  const a = agent.toLowerCase();
  return a === 'claude_code' || a === 'claude' || a.startsWith('claude');
}

function isCodexAgent(agent: string): boolean {
  return agent.toLowerCase() === 'codex';
}

function isAntigravityAgent(agent: string): boolean {
  return agent.toLowerCase() === 'antigravity';
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nextTierAtLeast(value: number): number | null {
  for (const tier of WINDOW_TIERS) {
    if (tier >= value) return tier;
  }
  return null;
}

export interface ResolveContextWindowInput {
  agent: string;
  model?: string | null;
  /** First-party window when the source reports one (e.g. Codex model_context_window). */
  reportedWindow?: number | null;
  /** Latest occupancy numerator, used only for the >100% guard. */
  observedTokens?: number | null;
  /** Config-supplied Codex default; falls back to the module constant. */
  codexDefaultWindow?: number;
}

/**
 * Resolve the context-window size for a session, or `null` when the agent has no
 * known window (occupancy is then unavailable rather than wrong).
 */
export function resolveContextWindow(input: ResolveContextWindowInput): number | null {
  let base: number | null;

  if (isPositiveFinite(input.reportedWindow)) {
    base = input.reportedWindow;
  } else if (isCodexAgent(input.agent)) {
    base = isPositiveFinite(input.codexDefaultWindow)
      ? input.codexDefaultWindow
      : CODEX_DEFAULT_CONTEXT_WINDOW;
  } else if (isClaudeAgent(input.agent)) {
    base = CLAUDE_DEFAULT_CONTEXT_WINDOW;
  } else if (isAntigravityAgent(input.agent)) {
    base = ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW;
  } else {
    base = null;
  }

  if (base === null) return null;

  if (isPositiveFinite(input.observedTokens) && input.observedTokens > base) {
    base = nextTierAtLeast(input.observedTokens) ?? input.observedTokens;
  }

  return base;
}

export interface Occupancy {
  used: number;
  window: number;
  pct: number;
}

/**
 * Turn a used-token count and a resolved window into an occupancy reading, or
 * `null` when either input is missing/invalid (unavailable, not `0%`).
 */
export function computeOccupancy(input: {
  usedTokens?: number | null;
  window?: number | null;
}): Occupancy | null {
  const used = input.usedTokens;
  const window = input.window;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (!isPositiveFinite(window)) return null;
  const pct = Math.min(100, Math.round((used / window) * 100));
  return { used, window, pct };
}

/** Resolve the window and compute occupancy in one step. `null` when unavailable. */
export function computeSessionOccupancy(input: ResolveContextWindowInput & {
  usedTokens?: number | null;
}): Occupancy | null {
  const window = resolveContextWindow(input);
  if (window === null) return null;
  return computeOccupancy({ usedTokens: input.usedTokens, window });
}
