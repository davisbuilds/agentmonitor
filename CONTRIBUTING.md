# Contributing

## Welcome and scope

Focused bug fixes, integration corrections, tests, accessibility improvements,
and documentation changes are welcome. Discuss substantial features, dependencies,
integrations, or public API/CLI changes before major implementation.

This is a solo-maintained project; contributions do not imply a support or
response-time commitment.

## Understanding and agent use

Agent-assisted work is welcome. Submitters should understand the change's purpose,
important behavior, tradeoffs, and verification limits. Explain what you checked
and what remains uncertain; no prompt transcript or manual rewrite is required.

## Choosing work

[Roadmap](docs/project/ROADMAP.md) records selected direction;
[Backlog](docs/project/BACKLOG.md) records unresolved work. Backlog entries can be
delegated directly to agents or become focused PRs. Use an issue when persistent
discussion, investigation, or coordination helps; there is no mandatory graduation
step. An entry or issue alone is not a feature commitment. When an issue owns the
details, keep only a useful linked summary in the backlog.

## Delivering a change

Work on a focused branch from `main` (or an appropriate parent for stacked work).
Keep commits coherent. Describe the problem and resulting behavior in the PR,
with relevant verification and limitations. Merge after applicable checks pass
and review conversations are resolved.

Start with [README](README.md) and [Operations](docs/system/OPERATIONS.md)
for setup. Applicable checks depend on the changed surface: see
[AGENTS](AGENTS.md#testing) and the [CI workflow](.github/workflows/ci.yml).

The [Git policy](docs/project/GIT_HISTORY_POLICY.md) preserves individual commits
through merge or rebase merges; squash merging is disabled. Tidy WIP/fixup
commits before submission.

Update the owning reference when its claims change and reconcile affected backlog
entries. Roadmap tracks direction; Git and PRs hold routine delivery history.
