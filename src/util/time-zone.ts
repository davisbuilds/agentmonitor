type EnvMap = Record<string, string | undefined>;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone days are reported in: `AGENTMONITOR_TIMEZONE` when valid, else the host's. */
export function resolveReportingTimeZone(env: EnvMap): string {
  const configured = env.AGENTMONITOR_TIMEZONE?.trim();
  if (configured && isValidTimeZone(configured)) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
