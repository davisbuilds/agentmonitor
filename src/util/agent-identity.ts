// Claude is stored under two names. The session browser (browsing_sessions, and
// the shared Analytics filter options read from it) says `claude`; events and the
// sessions lifecycle say `claude_code`; trace summaries hold either, depending on
// which source projected them. Every other agent uses one name everywhere.
//
// An agent filter accepts either spelling, and each read translates it to the
// spelling of the table it queries, so one filter value narrows every view.

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
