# Git History And Branch Hygiene

This document records the intended history policy. GitHub is authoritative for the
current remote settings; verify it before a merge-policy decision that depends on
the exact configuration.

Last verified against `davisbuilds/agentmonitor`: 2026-09-14.

## Intended Policy

- Preserve meaningful commit boundaries. Squash merging stays disabled.
- Use a merge commit by default so the PR remains a discoverable boundary.
- Rebase and merge when the branch already contains clean, reviewable commits and a
  linear history is materially clearer.
- Clean up WIP/fixup commits before merge because individual commits reach `main`.
- Delete merged remote branches.

## Current GitHub Settings

The live values on the verification date were:

| Setting | Value |
| --- | --- |
| Merge commits | enabled |
| Rebase merges | enabled |
| Squash merges | disabled |
| Delete branch on merge | enabled |
| `merge_commit_title` | `MERGE_MESSAGE` |
| `merge_commit_message` | `PR_TITLE` |

Query them directly:

```bash
gh api repos/davisbuilds/agentmonitor \
  --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge,merge_commit_title,merge_commit_message}'
```

## Main Protection

The live protected requirements on the verification date were:

- strict required checks: `Lint, Build, Test` and `E2E (Playwright)`;
- review conversations must be resolved; and
- required approving reviews: `0`.

Query them directly:

```bash
gh api repos/davisbuilds/agentmonitor/branches/main/protection \
  --jq '{strict:.required_status_checks.strict,contexts:.required_status_checks.contexts,conversations:.required_conversation_resolution.enabled,approvals:.required_pull_request_reviews.required_approving_review_count}'
```

Workflow source remains authoritative for what each job executes. The primary CI
workflow is [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml); security
and workflow-analysis jobs are defined separately.

## Working Hygiene

1. Create a short-lived branch from current `main`.
2. Commit coherent units with reviewable messages.
3. Run the repository's required local checks before pushing.
4. Resolve review threads and required checks before merging.
5. Use merge commit by default; choose rebase when the branch history already reads
   cleanly without a PR merge node.
6. Fetch with pruning and remove local branches already merged into `main`.
