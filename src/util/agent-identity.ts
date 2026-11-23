
/** The spelling browsing_sessions (and the Analytics filter options) use. */
export function browserAgentName(agent: string): string {
  return agent === 'claude_code' ? 'claude' : agent;
}

/** The spelling events and sessions use. */
export function eventAgentType(agent: string): string {
  return agent === 'claude' ? 'claude_code' : agent;
}

/** Every spelling an agent is stored under, for tables that hold more than one. */
export function agentSpellings(agent: string): string[] {
  const browser = browserAgentName(agent);
  const event = eventAgentType(agent);
  return browser === event ? [browser] : [browser, event];
}
