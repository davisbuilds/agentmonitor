# Contributing

Focused bug fixes, integration corrections, tests, accessibility improvements,
and documentation changes are welcome. Discuss substantial features, new
dependencies, integrations, or public API/CLI changes before major implementation.
A clear item in [BACKLOG.md](docs/project/BACKLOG.md) can go straight to a PR;
use an issue when persistent discussion or coordination helps.

Agent-assisted contributions are welcome. The submitter should understand the
change's purpose, important behavior, tradeoffs, and verification limits. A
prompting diary or human rewrite is not required.

Start with [README.md](README.md) and
[Operations](docs/system/OPERATIONS.md) for setup. Keep a PR focused, describe
its user-visible effect, and state what was verified or could not be checked.
The applicable gates depend on the changed surface: see [AGENTS.md](AGENTS.md#testing)
and the [CI workflow](.github/workflows/ci.yml).

This repository preserves individual commits. The
[history policy](docs/project/GIT_HISTORY_POLICY.md) explains the intended
merge strategy; GitHub settings verified on 2026-09-27 disabled squash merges.
Tidy WIP/fixup commits before submitting. The maintainer merges after applicable
checks and review conversations are resolved.
