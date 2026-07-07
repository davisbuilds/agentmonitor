# Git History and Branch Hygiene

Last updated: July 7, 2026

## Repository Merge Settings

Configured on GitHub repository `davisbuilds/agentmonitor`:

- `allow_squash_merge`: `false`
- `allow_merge_commit`: `true`
- `allow_rebase_merge`: `true`
- `delete_branch_on_merge`: `true`
- `merge_commit_title`: `PR_TITLE`
- `merge_commit_message`: `PR_BODY`

Result:

- PR branches retain their full commit history when merged.
- `main` receives either a merge commit (preserving the PR boundary) or rebased commits (linear history), depending on which strategy the merger picks for that PR.
- Squash merging is disabled — full per-commit history is preserved.
- Merged remote branches are auto-deleted.

## Merge Strategy

Merge commits and rebase merges are both allowed; squash merges are disabled — this repo tracks architectural work and regressions through focused, staged commits, and squashing would hide those logical boundaries.

- **Default — merge commit.** Preserves the PR as a discoverable boundary in `main`'s history, and keeps the intermediate commits addressable for archaeology, bisecting, and rollback. Best when the PR contains multiple meaningful commits.
- **Rebase merge.** Use when the PR's commits are clean and the linear history reads better without an extra merge node. Avoid if the PR's commits are noisy (WIP, fixups) — clean them up locally first.
- **Authoring expectation.** Because squash is gone, individual PR commits land in `main`. Keep PR commit messages tidy: meaningful subjects, no WIP markers, no fixup chains. Squash or reword locally before opening the PR if needed.

## CI Gates

GitHub Actions workflow: `.github/workflows/ci.yml`

Required merge gates on `main`:

- `Lint, Build, Test`
- review conversations must be resolved
- approving review count: `0`

That workflow runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm build`
- `pnpm test`

Manual/non-required checks:

- `pnpm test:parity:ts` for isolated TypeScript parity coverage when changing shared HTTP/API behavior
- `pnpm test:v2:contract:ts` when changing the canonical Svelte/v2 API contract on the TypeScript runtime

## Recommended Ongoing Hygiene

1. Create short-lived feature branches from `main`.
2. Open PRs early; keep them focused.
3. Tidy your PR commit history *before* merging — reword/squash locally so what lands on `main` reads cleanly.
4. Pick **Create a merge commit** by default; pick **Rebase and merge** when linear history is materially better. Merge only after the required GitHub check passes.
5. Periodically prune local branches:

```bash
git fetch --prune
git branch --merged main | grep -v ' main$' | xargs -n 1 git branch -d
```
