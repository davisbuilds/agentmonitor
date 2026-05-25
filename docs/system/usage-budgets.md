# Usage Budgets

AgentMonitor can report read-only budget state from an optional local JSON file. Budgets reuse the same event-derived usage summary and filters as `/api/v2/usage/summary`.

Default config path:

```text
./config/budgets.json
```

Override it with:

```bash
AGENTMONITOR_USAGE_BUDGETS_PATH=/path/to/budgets.json
```

If the file is absent, `GET /api/v2/usage/budgets` returns an empty `data` list with `config.present=false`.

## Example

```json
{
  "budgets": [
    {
      "name": "Alpha Sonnet monthly",
      "period": "month",
      "limit_usd": 25,
      "thresholds": {
        "info": 50,
        "warning": 75,
        "critical": 90,
        "hard_stop_candidate": 100
      },
      "filters": {
        "project": "alpha",
        "provider": "anthropic",
        "tier": "sonnet"
      }
    }
  ]
}
```

Supported `period` values:

- `day`: today.
- `week`: trailing seven calendar days including today.
- `month`: current calendar month to date.
- `all_time`: no date filter.

Supported filters:

- `project`
- `agent`
- `model`
- `provider`
- `tier`

## Response

Each budget report includes:

- configured limit and filters
- current spend from matching usage rows
- remaining spend
- percent used
- alert state: `ok`, `info`, `warning`, `critical`, or `hard_stop_candidate`
- `enforcing: false`

Malformed config returns HTTP 200 with `config.valid=false`, no budget data, and validation errors. The endpoint does not block hooks, reject events, stop agents, or enforce spending. Hook enforcement would be a separate opt-in feature.
