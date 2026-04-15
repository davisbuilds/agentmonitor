# Roadmap

Directional roadmap for AgentMonitor. This is a planning snapshot, not a release contract or detailed implementation log.

## Now

- Establish the Svelte app at `/app/` and `/api/v2/*` as the clear product center.
- Keep carrying forward durable localhost-monitoring behavior from the older v1 surface where it still adds operator value.
- Converge the Rust backend onto the same canonical web contract instead of letting it evolve as a separate product shape.
- Improve the Live surface, especially around fidelity boundaries, session noise, and operator clarity when data is summary-only.

## Next

- Define and verify parity gates for retiring or sharply reducing reliance on the legacy `/` dashboard.
- Tighten v2 contract coverage and runtime parity testing across the TypeScript and Rust backends.
- Keep improving session browsing, search, analytics, and live inspection where real operator workflows expose gaps.
- Make integration behavior and capture/redaction settings easier to understand from the product surface and docs.

## Later

- Support richer Codex-native live fidelity beyond the current OTEL summary path.
- Revisit packaging or alternate runtime distribution work once the canonical web contract is stable.
- Expand multi-agent support where new integrations can map cleanly onto the existing monitor, history, and live models.

## Working Principles

- Prefer extending `/app/` and `/api/v2/*` over adding new behavior to the legacy `/` surface.
- Treat Rust as a runtime convergence effort, not a forked product direction.
- Keep fidelity honest in both product UI and API responses, especially when Claude and Codex capabilities differ.
- Favor docs and plans that age well: roadmap for direction, plan docs for implementation detail, architecture docs for system shape.

## Active References

- Repo convergence plan: [../plans/2026-04-08-repo-convergence-implementation.md](../plans/2026-04-08-repo-convergence-implementation.md)
- Rust runtime convergence plan: [../plans/2026-04-10-rust-runtime-convergence.md](../plans/2026-04-10-rust-runtime-convergence.md)
- Architecture overview: [../system/ARCHITECTURE.md](../system/ARCHITECTURE.md)
- Product surface reference: [../system/FEATURES.md](../system/FEATURES.md)
