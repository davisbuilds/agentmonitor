export const CODEX_CONTEXT_EVIDENCE_VERSION = 1;

export function hasCurrentCodexContextEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return false;
    }
  }
  return value !== null && typeof value === 'object'
    && 'codexEvidenceVersion' in value
    && value.codexEvidenceVersion === CODEX_CONTEXT_EVIDENCE_VERSION;
}
