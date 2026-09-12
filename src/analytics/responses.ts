import {
  getAnalyticsActivity,
  getAnalyticsAgents,
  getAnalyticsCoverage,
  getAnalyticsHourOfWeek,
  getAnalyticsProjects,
  getAnalyticsSkillHealthParts,
  getAnalyticsSkillsDaily,
  getAnalyticsSummary,
  getAnalyticsTools,
  getAnalyticsTopSessions,
  getAnalyticsVelocity,
  refreshSkillCatalogSnapshots,
} from '../db/v2-queries.js';
import { getDb } from '../db/connection.js';
import type {
  ActivityDataPoint,
  AgentComparisonRow,
  AnalyticsCoverage,
  AnalyticsDataResponse,
  AnalyticsOverview,
  AnalyticsParams,
  AnalyticsSummary,
  HourOfWeekDataPoint,
  ProjectBreakdown,
  SkillHealthResponse,
  SkillUsageDay,
  ToolUsageStat,
  TopSessionStat,
  VelocityMetrics,
} from '../api/v2/types.js';

function response<T>(data: T[], coverage: AnalyticsCoverage): AnalyticsDataResponse<T> {
  return { data, coverage };
}

export function getAnalyticsSummaryResponse(params: AnalyticsParams = {}): AnalyticsSummary {
  return getAnalyticsSummary(params);
}

export function getAnalyticsActivityResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<ActivityDataPoint> {
  return response(getAnalyticsActivity(params), getAnalyticsCoverage(params, 'all_sessions'));
}

export function getAnalyticsProjectsResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<ProjectBreakdown> {
  return response(getAnalyticsProjects(params), getAnalyticsCoverage(params, 'all_sessions'));
}

export function getAnalyticsToolsResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<ToolUsageStat> {
  return response(getAnalyticsTools(params), getAnalyticsCoverage(params, 'tool_analytics_capable'));
}

export function getAnalyticsSkillsDailyResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<SkillUsageDay> {
  return response(getAnalyticsSkillsDaily(params), getAnalyticsCoverage(params, 'all_sessions'));
}

function buildAnalyticsSkillHealthResponse(
  params: AnalyticsParams,
  coverage: AnalyticsCoverage,
  catalog: ReturnType<typeof refreshSkillCatalogSnapshots>,
): SkillHealthResponse {
  const health = getAnalyticsSkillHealthParts(params, catalog);
  const compatibilityOnly = health.consultations.comparability.status === 'not_directly_comparable';

  return {
    data: health.data.map(row => ({
      ...row,
      compatibilityOnly,
      crossHarnessComparable: !compatibilityOnly,
    })),
    coverage,
    dataSemantics: {
      data: 'phase_1_compatibility',
      window: 'session_start_legacy',
      compatibilityOnly,
      crossHarnessComparable: !compatibilityOnly,
    },
    consultations: health.consultations,
  };
}

export function getAnalyticsSkillHealthResponse(params: AnalyticsParams = {}): SkillHealthResponse {
  const catalog = refreshSkillCatalogSnapshots();
  return buildAnalyticsSkillHealthResponse(
    params,
    getAnalyticsCoverage(params, 'all_sessions'),
    catalog,
  );
}

export function getAnalyticsHourOfWeekResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<HourOfWeekDataPoint> {
  return response(getAnalyticsHourOfWeek(params), getAnalyticsCoverage(params, 'all_sessions'));
}

export function getAnalyticsTopSessionsResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<TopSessionStat> {
  return response(getAnalyticsTopSessions(params), getAnalyticsCoverage(params, 'all_sessions'));
}

export function getAnalyticsAgentsResponse(
  params: AnalyticsParams = {},
): AnalyticsDataResponse<AgentComparisonRow> {
  return response(getAnalyticsAgents(params), getAnalyticsCoverage(params, 'all_sessions'));
}

export function getAnalyticsVelocityResponse(params: AnalyticsParams = {}): VelocityMetrics {
  return getAnalyticsVelocity(params);
}

export function getAnalyticsOverview(params: AnalyticsParams = {}): AnalyticsOverview {
  const catalog = refreshSkillCatalogSnapshots();
  return getDb().transaction(() => {
    const summary = getAnalyticsSummaryResponse(params);
    const allSessionsCoverage = summary.coverage;
    const toolCoverage = getAnalyticsCoverage(params, 'tool_analytics_capable');

    return {
      summary,
      activity: response(getAnalyticsActivity(params), allSessionsCoverage),
      projects: response(getAnalyticsProjects(params), allSessionsCoverage),
      tools: response(getAnalyticsTools(params), toolCoverage),
      skills_daily: response(getAnalyticsSkillsDaily(params), allSessionsCoverage),
      skills_health: buildAnalyticsSkillHealthResponse(params, allSessionsCoverage, catalog),
      hour_of_week: response(getAnalyticsHourOfWeek(params), allSessionsCoverage),
      top_sessions: response(getAnalyticsTopSessions(params), allSessionsCoverage),
      velocity: getAnalyticsVelocityResponse(params),
      agents: response(getAnalyticsAgents(params), allSessionsCoverage),
    };
  })();
}
