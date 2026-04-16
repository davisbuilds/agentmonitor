import type {
  UsageSummary,
  UsageDailyPoint,
  UsageProjectBreakdown,
  UsageModelBreakdown,
  UsageAgentBreakdown,
  UsageTopSessionRow,
} from './api/client';

export interface UsageFilters {
  from: string;
  to: string;
  project: string;
  agent: string;
}

export interface UsageCsvPayload {
  generatedAt: string;
  filters: UsageFilters;
  summary: UsageSummary | null;
  daily: UsageDailyPoint[];
  projects: UsageProjectBreakdown[];
  models: UsageModelBreakdown[];
  agents: UsageAgentBreakdown[];
  topSessions: UsageTopSessionRow[];
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createDefaultUsageFilters(now = new Date()): UsageFilters {
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  return {
    from: localDateString(from),
    to: localDateString(now),
    project: '',
    agent: '',
  };
}

export function buildUsageHash(filters: UsageFilters): string {
  const params = new URLSearchParams();
  params.set('from', filters.from);
  params.set('to', filters.to);
  if (filters.project) params.set('project', filters.project);
  if (filters.agent) params.set('agent', filters.agent);
  const suffix = params.toString();
  return suffix ? `usage?${suffix}` : 'usage';
}

export function parseUsageHash(hash: string, fallback: UsageFilters): UsageFilters {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash;
  const [tab, query = ''] = normalized.split('?');
  if (tab !== 'usage') return fallback;

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

export function buildUsageCsv(payload: UsageCsvPayload): string {
  const lines: string[] = ['Section,Metric,Value'];

  lines.push(sectionRow('Meta', 'Generated At', payload.generatedAt));
  lines.push(sectionRow('Filters', 'From', payload.filters.from));
  lines.push(sectionRow('Filters', 'To', payload.filters.to));
  lines.push(sectionRow('Filters', 'Project', payload.filters.project || 'All'));
  lines.push(sectionRow('Filters', 'Agent', payload.filters.agent || 'All'));

  if (payload.summary) {
    lines.push(sectionRow('Summary', 'Total Cost USD', payload.summary.total_cost_usd));
    lines.push(sectionRow('Summary', 'Input Tokens', payload.summary.total_input_tokens));
    lines.push(sectionRow('Summary', 'Output Tokens', payload.summary.total_output_tokens));
    lines.push(sectionRow('Summary', 'Cache Read Tokens', payload.summary.total_cache_read_tokens));
    lines.push(sectionRow('Summary', 'Cache Write Tokens', payload.summary.total_cache_write_tokens));
    lines.push(sectionRow('Summary', 'Usage Events', payload.summary.total_usage_events));
    lines.push(sectionRow('Summary', 'Sessions', payload.summary.total_sessions));
    lines.push(sectionRow('Summary', 'Coverage Note', payload.summary.coverage.note));
  }

  if (payload.daily.length > 0) {
    lines.push('');
    lines.push('Daily Usage');
    lines.push('Date,Cost USD,Input Tokens,Output Tokens,Cache Read Tokens,Cache Write Tokens,Usage Events,Sessions');
    for (const row of payload.daily) {
      lines.push(tableRow([
        row.date,
        row.cost_usd,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
        row.usage_events,
        row.session_count,
      ]));
    }
  }

  if (payload.projects.length > 0) {
    lines.push('');
    lines.push('Projects');
    lines.push('Project,Cost USD,Input Tokens,Output Tokens,Usage Events,Sessions');
    for (const row of payload.projects) {
      lines.push(tableRow([
        row.project,
        row.cost_usd,
        row.input_tokens,
        row.output_tokens,
        row.usage_events,
        row.session_count,
      ]));
    }
  }

  if (payload.models.length > 0) {
    lines.push('');
    lines.push('Models');
    lines.push('Model,Cost USD,Input Tokens,Output Tokens,Usage Events,Sessions');
    for (const row of payload.models) {
      lines.push(tableRow([
        row.model,
        row.cost_usd,
        row.input_tokens,
        row.output_tokens,
        row.usage_events,
        row.session_count,
      ]));
    }
  }

  if (payload.agents.length > 0) {
    lines.push('');
    lines.push('Agents');
    lines.push('Agent,Cost USD,Input Tokens,Output Tokens,Usage Events,Sessions');
    for (const row of payload.agents) {
      lines.push(tableRow([
        row.agent,
        row.cost_usd,
        row.input_tokens,
        row.output_tokens,
        row.usage_events,
        row.session_count,
      ]));
    }
  }

  if (payload.topSessions.length > 0) {
    lines.push('');
    lines.push('Top Sessions');
    lines.push('Session ID,Project,Agent,Cost USD,Input Tokens,Output Tokens,Usage Events,All Events,Started At,Last Activity,Has Browsing Session');
    for (const row of payload.topSessions) {
      lines.push(tableRow([
        row.id,
        row.project,
        row.agent,
        row.cost_usd,
        row.input_tokens,
        row.output_tokens,
        row.usage_events,
        row.event_count,
        row.started_at,
        row.last_activity_at,
        row.browsing_session_available,
      ]));
    }
  }

  return lines.join('\n');
}

export function downloadUsageCsv(filename: string, csv: string): void {
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
