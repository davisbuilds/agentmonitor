# Git History and Branch Hygiene

Last updated: April 10, 2026

## Repository Merge Settings

Configured on GitHub repository `davisbuilds/agentmonitor`:

- `allow_squash_merge`: `false`
- `allow_merge_commit`: `true`
- `allow_rebase_merge`: `false`
- `delete_branch_on_merge`: `true`
- `merge_commit_title`: `MERGE_MESSAGE`
- `merge_commit_message`: `PR_TITLE`

Result:

- PR branches can contain multiple commits.
- `main` preserves the branch's logical commit history via merge commits.
- Merged remote branches are auto-deleted.

## Merge Strategy

Merge-commit only. Squash and rebase merges are disabled at the repository level.

Reasoning:

- This repo is using focused, staged commits to track architectural work and regressions.
- Merge commits preserve that intermediate history for later archaeology, bisecting, and rollback.
- Squashing hides those logical boundaries and makes long-running convergence work harder to audit.

## CI Gates

GitHub Actions workflow: `.github/workflows/ci.yml`

Required check before merge on `main`:

- `Lint, Build, Test`

That workflow runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm build`
- `pnpm test`

Manual/non-required checks:

- `pnpm test:parity:ts` for isolated TypeScript parity coverage when changing shared HTTP/API behavior
- `pnpm test:v2:contract:ts` when changing the canonical Svelte/v2 API contract on the TypeScript runtime
- `pnpm test:parity:rust` when validating Rust parity explicitly

## Recommended Ongoing Hygiene

1. Create short-lived feature branches from `main`.
2. Open PRs early; keep them focused.
3. Merge only with **Create a merge commit** after the required GitHub check passes.
4. Periodically prune local branches:

```bash
git fetch --prune
git branch --merged main | grep -v ' main$' | xargs -n 1 git branch -d
```
