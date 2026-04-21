import type {
  AnalyticsSummary,
  VelocityMetrics,
  ActivityDataPoint,
  ProjectBreakdown,
  ToolUsageStat,
  SkillUsageDay,
  TopSessionStat,
  AgentComparisonRow,
} from './api/client';

export interface AnalyticsFilters {
  from: string;
  to: string;
  project: string;
  agent: string;
}

export interface AnalyticsCsvPayload {
  generatedAt: string;
  filters: AnalyticsFilters;
  summary: AnalyticsSummary | null;
  velocity: VelocityMetrics | null;
  activity: ActivityDataPoint[];
  projects: ProjectBreakdown[];
  tools: ToolUsageStat[];
  skills: SkillUsageDay[];
  topSessions: TopSessionStat[];
  agents: AgentComparisonRow[];
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createDefaultAnalyticsFilters(now = new Date()): AnalyticsFilters {
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  return {
    from: localDateString(from),
    to: localDateString(now),
    project: '',
    agent: '',
  };
}

export function buildAnalyticsHash(filters: AnalyticsFilters): string {
  const params = new URLSearchParams();
  params.set('from', filters.from);
  params.set('to', filters.to);
  if (filters.project) params.set('project', filters.project);
  if (filters.agent) params.set('agent', filters.agent);
  const suffix = params.toString();
  return suffix ? `analytics?${suffix}` : 'analytics';
}

export function parseAnalyticsHash(hash: string, fallback: AnalyticsFilters): AnalyticsFilters {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash;
  const [tab, query = ''] = normalized.split('?');
  if (tab !== 'analytics') return fallback;

  const params = new URLSearchParams(query);
  return {
    from: params.get('from') || fallback.from,
    to: params.get('to') || fallback.to,
    project: params.get('project') || '',
    agent: params.get('agent') || '',
  };
}

function csvEscape(value: string | number | null | undefined): string {
  const stringValue = value == null ? '' : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function sectionRow(section: string, metric: string, value: string | number | null | undefined): string {
  return [section, metric, value].map(csvEscape).join(',');
}

function tableRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(',');
}

export function buildAnalyticsCsv(payload: AnalyticsCsvPayload): string {
  const lines: string[] = ['Section,Metric,Value'];

  lines.push(sectionRow('Meta', 'Generated At', payload.generatedAt));
  lines.push(sectionRow('Filters', 'From', payload.filters.from));
  lines.push(sectionRow('Filters', 'To', payload.filters.to));
  lines.push(sectionRow('Filters', 'Project', payload.filters.project || 'All'));
  lines.push(sectionRow('Filters', 'Agent', payload.filters.agent || 'All'));

  if (payload.summary) {
    lines.push(sectionRow('Summary', 'Total Sessions', payload.summary.total_sessions));
    lines.push(sectionRow('Summary', 'Total Messages', payload.summary.total_messages));
    lines.push(sectionRow('Summary', 'Total User Messages', payload.summary.total_user_messages));
    lines.push(sectionRow('Summary', 'Daily Average Sessions', payload.summary.daily_average_sessions));
    lines.push(sectionRow('Summary', 'Daily Average Messages', payload.summary.daily_average_messages));
    lines.push(sectionRow('Summary', 'Coverage Scope', payload.summary.coverage.metric_scope));
    lines.push(sectionRow('Summary', 'Coverage Note', payload.summary.coverage.note));
  }

  if (payload.velocity) {
    lines.push(sectionRow('Velocity', 'Active Days', payload.velocity.active_days));
    lines.push(sectionRow('Velocity', 'Span Days', payload.velocity.span_days));
    lines.push(sectionRow('Velocity', 'Sessions Per Active Day', payload.velocity.sessions_per_active_day));
    lines.push(sectionRow('Velocity', 'Messages Per Active Day', payload.velocity.messages_per_active_day));
    lines.push(sectionRow('Velocity', 'Sessions Per Calendar Day', payload.velocity.sessions_per_calendar_day));
    lines.push(sectionRow('Velocity', 'Messages Per Calendar Day', payload.velocity.messages_per_calendar_day));
    lines.push(sectionRow('Velocity', 'Average Messages Per Session', payload.velocity.average_messages_per_session));
  }

  if (payload.activity.length > 0) {
    lines.push('');
    lines.push('Activity By Day');
    lines.push('Date,Sessions,Messages,User Messages');
    for (const row of payload.activity) {
      lines.push(tableRow([row.date, row.sessions, row.messages, row.user_messages]));
    }
  }

  if (payload.projects.length > 0) {
    lines.push('');
    lines.push('Projects');
    lines.push('Project,Sessions,Messages,User Messages');
    for (const row of payload.projects) {
      lines.push(tableRow([row.project, row.session_count, row.message_count, row.user_message_count]));
    }
  }

  if (payload.tools.length > 0) {
    lines.push('');
    lines.push('Tools');
    lines.push('Tool,Category,Count');
    for (const row of payload.tools) {
      lines.push(tableRow([row.tool_name, row.category, row.count]));
    }
  }

  if (payload.skills.length > 0) {
    lines.push('');
    lines.push('Skills By Day');
    lines.push('Date,Skill,Count');
    for (const day of payload.skills) {
      for (const skill of day.skills) {
        lines.push(tableRow([day.date, skill.skill_name, skill.count]));
      }
    }
  }

  if (payload.topSessions.length > 0) {
    lines.push('');
    lines.push('Top Sessions');
    lines.push('Session ID,Project,Agent,Messages,User Messages,Tool Calls,Fidelity,Started At,Ended At');
    for (const row of payload.topSessions) {
      lines.push(tableRow([
        row.id,
        row.project,
        row.agent,
        row.message_count,
        row.user_message_count,
        row.tool_call_count,
        row.fidelity,
        row.started_at,
        row.ended_at,
      ]));
    }
  }

  if (payload.agents.length > 0) {
    lines.push('');
    lines.push('Agent Comparison');
    lines.push('Agent,Sessions,Messages,User Messages,Average Messages,Full Fidelity,Summary Fidelity,Tool Analytics Capable');
    for (const row of payload.agents) {
      lines.push(tableRow([
        row.agent,
        row.session_count,
        row.message_count,
        row.user_message_count,
        row.average_messages_per_session,
        row.full_fidelity_sessions,
        row.summary_fidelity_sessions,
        row.tool_analytics_capable_sessions,
      ]));
    }
  }

  return lines.join('\n');
}

export function downloadAnalyticsCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
