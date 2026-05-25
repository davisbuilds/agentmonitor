# Tier Feedback

`GET /api/v2/usage/tier-feedback` returns advisory model-tier feedback from event-derived usage data. The endpoint is intentionally read-only and does not change hooks, agents, prompts, model choices, or budget behavior.

The report uses existing usage metrics only:

- usage summary totals
- model attribution rows
- top usage sessions
- browsing-session metadata such as message counts and timestamps when available

It does not inspect private message content.

## Query Filters

The endpoint accepts the same usage filters as the rest of `/api/v2/usage/*`:

- `date_from`
- `date_to`
- `project`
- `agent`
- `model`
- `provider`
- `tier`

## Report Shape

The response includes:

- `generated_at`
- `window`
- `tier_mismatches`
- `cost_outliers`
- `confidence`
- `evidence`
- `human_review_required: true`

Current conservative findings:

- `high_cost_low_tier`: repeated high-cost sessions on economy, haiku, or flash-like tiers.
- `low_complexity_premium_tier`: repeated low-cost, low-token, short sessions on premium, opus, pro, or ultra-like tiers.
- `unknown_model_spend`: unknown models account for a dominant share of spend.

Each finding includes supporting evidence such as session count, total cost, sample sessions, or sample models. Findings are sorted deterministically by cost and evidence strength.

## Human Review Boundary

Tier feedback is not an automatic recommendation engine. Treat it as a triage report that points to sessions or models worth reviewing. Any model-routing, subagent policy, hook enforcement, or prompt change should be designed and reviewed separately before being applied.
