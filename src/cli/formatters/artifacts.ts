import type {
  BenchmarkStudyDetail,
  BenchmarkStudySummary,
  InsightRow,
  TraceQualityObservation,
  TraceQualityTraceDetail,
} from '../../api/v2/types.js';
import { formatTable, sanitizeTerminal } from '../output.js';

function display(value: unknown): string {
  return sanitizeTerminal(value == null || value === '' ? '-' : value);
}

export function formatTraceDetail(trace: TraceQualityTraceDetail): string {
  return [
    `Trace: ${display(trace.id)}`,
    `Session: ${display(trace.session_id)}`,
    `Status: ${display(trace.status)}`,
    `Project: ${display(trace.project)}`,
    `Agent: ${display(trace.agent_type)}`,
    `Observations: ${trace.aggregate.observation_count}`,
  ].join('\n');
}

export function formatObservations(observations: TraceQualityObservation[]): string {
  if (observations.length === 0) return '(no observations)';
  return formatTable([
    ['ID', 'TYPE', 'NAME', 'STATUS', 'MODEL', 'TOOL'],
    ...observations.map(observation => [
      display(observation.id),
      display(observation.observation_type),
      display(observation.name),
      display(observation.status),
      display(observation.model),
      display(observation.tool_name),
    ]),
  ]);
}

export function formatInsights(insights: InsightRow[]): string {
  if (insights.length === 0) return '(no insights)';
  return formatTable([
    ['ID', 'KIND', 'TITLE', 'DATE FROM', 'DATE TO', 'PROJECT', 'AGENT'],
    ...insights.map(insight => [
      display(insight.id),
      display(insight.kind),
      display(insight.title),
      display(insight.date_from),
      display(insight.date_to),
      display(insight.project),
      display(insight.agent),
    ]),
  ]);
}

export function formatInsight(insight: InsightRow): string {
  return [
    `${display(insight.title)} (#${insight.id})`,
    `${display(insight.kind)} · ${display(insight.date_from)} to ${display(insight.date_to)}`,
    `Project: ${display(insight.project)} · Agent: ${display(insight.agent)}`,
    `Provider: ${display(insight.provider)} · Model: ${display(insight.model)}`,
    '',
    sanitizeTerminal(insight.content),
  ].join('\n');
}

export function formatBenchmarkStudies(studies: BenchmarkStudySummary[]): string {
  if (studies.length === 0) return '(no benchmark studies)';
  return formatTable([
    ['STUDY ID', 'STUDY', 'SUITE', 'ARMS', 'CELLS', 'TOTAL COST', 'COST BASIS'],
    ...studies.map(study => [
      display(study.study_id),
      display(study.study),
      display(study.suite),
      display(study.arm_count),
      display(study.cell_count),
      study.total_cost_usd == null ? '-' : `$${study.total_cost_usd.toFixed(4)}`,
      display(study.cost_basis),
    ]),
  ]);
}

export function formatBenchmarkStudy(study: BenchmarkStudyDetail): string {
  const header = [
    `Study: ${display(study.study)} (${display(study.study_id)})`,
    `Suite: ${display(study.suite)} · Tasks: ${study.tasks.map(display).join(', ') || '-'}`,
    `Expected trials per arm: ${study.expected_trials}`,
  ].join('\n');
  if (study.arms.length === 0) return header;
  return `${header}\n\n${formatTable([
    ['ARM', 'N', 'MEAN SCORE', 'COST/TRIAL', 'VERDICT', 'RANKING ELIGIBLE'],
    ...study.arms.map(arm => [
      display(arm.label),
      display(arm.n),
      display(arm.mean_score),
      arm.cost_per_trial == null ? '-' : `$${arm.cost_per_trial.toFixed(4)}`,
      display(arm.verdict),
      display(arm.ranking_eligible),
    ]),
  ])}`;
}

export function formatStringList(label: string, values: string[]): string {
  if (values.length === 0) return `(no ${label.toLowerCase()})`;
  return formatTable([[label], ...values.map(value => [display(value)])]);
}
