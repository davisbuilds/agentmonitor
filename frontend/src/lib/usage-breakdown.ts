// Rows for Usage's one breakdown table: the selected dimension's rows with
// their share of the range's cost and their change against the period before.
import type {
  UsageAgentBreakdown,
  UsageModelBreakdown,
  UsagePriorCosts,
  UsageProjectBreakdown,
  UsageTierBreakdown,
} from './api/client';
import { agentName, formatModelName } from './format';
import { percentChange, type ChangeLabel } from './overview-headlines';
import { usageTokenSplit, usageTokenTotal } from './usage-tokens';

export type BreakdownDimension = 'model' | 'project' | 'agent' | 'tier';

export const BREAKDOWN_DIMENSIONS: Array<{ id: BreakdownDimension; label: string }> = [
  { id: 'model', label: 'Model' },
  { id: 'project', label: 'Project' },
  { id: 'agent', label: 'Agent' },
  { id: 'tier', label: 'Tier' },
];

export interface BreakdownSource {
  models: UsageModelBreakdown[];
  projects: UsageProjectBreakdown[];
  agents: UsageAgentBreakdown[];
  tiers: UsageTierBreakdown[];
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** The raw identity, when the label shortens it (a model ID). */
  title?: string;
  /** Pricing caveats: an unknown or deprecated model, unknown events in a tier. */
  note?: string;
  /** What selecting the row sets: a project or agent filter. */
  filter?: { kind: 'project' | 'agent'; value: string };
  cost: number;
  /** The row's share of the range's cost; null when nothing in the range cost anything. */
  share: number | null;
  change: ChangeLabel | null;
  tokens: number;
  tokenSplit: string;
  sessions: number;
  events: number;
}

type AnyRow = UsageModelBreakdown | UsageProjectBreakdown | UsageAgentBreakdown | UsageTierBreakdown;

function identity(dimension: BreakdownDimension, row: AnyRow): Pick<BreakdownRow, 'key' | 'label' | 'title' | 'note' | 'filter'> {
  if (dimension === 'model') {
    const model = row as UsageModelBreakdown;
    return {
      key: model.model,
      label: formatModelName(model.model),
      title: model.model,
      note: model.pricing_status !== 'known' ? model.pricing_status : undefined,
    };
  }
  if (dimension === 'project') {
    const { project } = row as UsageProjectBreakdown;
    // Selecting the unattributed bucket clears the project filter, as before.
    return { key: project, label: project === 'unknown' ? 'No project' : project, filter: { kind: 'project', value: project === 'unknown' ? '' : project } };
  }
  if (dimension === 'agent') {
    const { agent } = row as UsageAgentBreakdown;
    return { key: agent, label: agentName(agent), filter: { kind: 'agent', value: agent } };
  }
  const tier = row as UsageTierBreakdown;
  return {
    key: `${tier.provider}/${tier.tier}`,
    label: `${tier.provider} / ${tier.tier}`,
    note: tier.unknown_model_events > 0 ? `${tier.unknown_model_events} unknown` : undefined,
  };
}

/**
 * A row the period before lacks is new; a jump of ten times or more reads as a
 * multiple, since a row that cost cents before would otherwise say +14886%.
 */
function costChange(cost: number, prior: number | null): ChangeLabel | null {
  if (prior === 0 && cost > 0) return { value: 'new', tone: 'muted' };
  if (prior !== null && prior > 0 && cost / prior >= 10) return { value: `${Math.round(cost / prior)}×`, tone: 'danger' };
  return percentChange(cost, prior, 'up-is-bad');
}

export function breakdownRows(
  dimension: BreakdownDimension,
  source: BreakdownSource,
  priorCosts: UsagePriorCosts | null,
): BreakdownRow[] {
  const rows: AnyRow[] = { model: source.models, project: source.projects, agent: source.agents, tier: source.tiers }[dimension];
  const prior = priorCosts?.range ? { model: priorCosts.models, project: priorCosts.projects, agent: priorCosts.agents, tier: priorCosts.tiers }[dimension] : null;
  const total = rows.reduce((sum, row) => sum + row.cost_usd, 0);
  return rows.map(row => {
    const id = identity(dimension, row);
    return {
      ...id,
      cost: row.cost_usd,
      share: total > 0 ? row.cost_usd / total : null,
      change: costChange(row.cost_usd, prior ? prior[id.key] ?? 0 : null),
      tokens: usageTokenTotal(row),
      tokenSplit: usageTokenSplit(row),
      sessions: row.session_count,
      events: row.usage_events,
    };
  });
}
