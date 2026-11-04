---
date: 2026-11-03
author: Claude (Opus 5.5)
topic: cost-per-outcome
stage: plan
status: complete
source: conversation
risk_profile: routine
readiness: ready
---

# Cost Per Outcome Plan

## Goal

Show what the agents' spend produced: for the selected range, how much of the
spend preceded work that landed on a main branch, what a merged pull request
costs (its distribution, and all spend divided by merged PRs), how that moves
over time and with PR size, and per project, each beside the coverage it rests
on.

Accepted in conversation (2026-11-03):
- Unit: dollars, as Usage counts them (API-rate estimates).
- Bar: **landed on main**. A merged pull request, or a commit on a main
  branch's first-parent line (a direct push). Cost per merged PR is still
  reported on its own.
- The Claude vs Codex comparison is deferred. The global agent filter still
  applies, as on every panel; no side-by-side comparison is drawn.

Evidence from an exploration over a store snapshot (June-October 2026), which
this plan productizes. All figures are ratios:
- About 92% of observable spend preceded something that landed: merged PRs
  ~70%, direct pushes ~18%. Spend with nothing after it is 4-9%; not landed
  ~1%; unobservable (no transcript or no tool calls) ~3.5%.
- A session is a workstream, not a work item. 98% of merged PRs come from one
  session, but a session with any merged PR has a median of 16 of them. Cost
  must therefore be allocated along a session's timeline, not split per
  session.
- Allocating each minute of cost to the same root session's next milestone,
  or to its previous one, gives medians within ~10% of each other. The rule
  is not what drives the result.
- Cost tracks size (Spearman 0.55 with lines changed). Spread between PRs in
  one project is ~2.6x the spread between projects (log sd), so per-project
  figures need partial pooling.
- Cost per merged PR fell to 0.34x over five months after adjusting for
  project and size. Most of that is quantity (output tokens per PR 0.47x),
  not price ($/Mtok -22%). The trend therefore shows tokens and price as well
  as dollars.
- Coverage moves. The share of the maintainer's merged PRs (GitHub
  `author:@me`) linked to a session on this machine went from 85-97% to 63%
  as other machines opened more of them, so coverage is shown with every
  number.

## Scope

### In Scope

- Collection:
  - each merged PR's commits, size and author;
  - each stored commit's landing (direct, merged, or not on a main);
  - local PR membership from merge commits when GitHub lookups are off.
- `GET /api/v2/analytics/outcomes` and its frontend client and store panel.
- A "Cost per outcome" section in the Analytics Git sub-view:
  - headline tiles;
  - a bar showing where spend went;
  - a weekly trend, with tokens per PR and $/Mtok as separate small charts;
  - cost by size bucket;
  - a project table with pooled estimates;
  - a coverage line.
- `amon sync git` reporting, docs (FEATURES, ARCHITECTURE, OPERATIONS,
  README outbound list), schema v29.

### Out of Scope

- A Claude vs Codex comparison view (deferred by the maintainer).
- Quota as the unit (dollars chosen; quota history is too short).
- "Still standing after N days" (revert or follow-up detection). Merged is
  the bar.
- Friction vs no-outcome spend (no-outcome spend is 2-9%; low value now).
- Separating "the same work split into more PRs" from "the same work for
  less". Not identifiable from this data; FEATURES says so.
- GitHub Enterprise or GitLab hosts, which the existing lookups don't cover
  either.

## Assumptions And Constraints

- GitHub lookups stay opt-in (`AGENTMONITOR_GITHUB_LOOKUPS=1`, #251). With
  them off, everything still works from local git:
  - landing;
  - PR membership from merge commits only (a squash merge's commits stay
    unlinked);
  - merged state from local merge commits.

  The section says which applies.
- GitHub is read only, through `gh`, as the signed-in user, like the existing
  state lookups. Observed 2026-11-03: one GraphQL `search(type: ISSUE, query:
  "is:pr is:merged author:@me merged:<from>..<to>")` returns `issueCount`, the
  repository, size fields, `author { __typename }` and `commits { totalCount
  nodes { commit { oid } } }` at a rate-limit cost of 1. GitHub search returns
  at most 1,000 results per query (documented limit), so passes walk
  month-sized windows and split any window that reports more.
- Dollars come from `getUsageRows`, so the Monitor's and Usage's exclusions
  (benchmark rows, overlapping Codex OTEL) apply unchanged.
- Remote-tracking refs are as fresh as the repository's last `git fetch`. The
  poller never fetches (it is read-only), so landing lags until the
  maintainer next fetches.
- Public repository: code, tests and docs cite ratios and synthetic fixtures,
  not the maintainer's dollar figures or repository names.

## Map Before You Cut

**Data path today.**
1. `src/git/service.ts` runs `syncGitActivity` (`src/git/activity.ts`):
   `git log --all` per repository into `git_commits`, with `%P` read only to
   set `is_merge`.
2. It then runs `syncSessionPullRequests` (`src/git/github.ts`), which asks
   for `state mergedAt createdAt` of session-opened PRs into
   `github_pull_requests`.
3. At read time, `getAnalyticsGitActivity` (`src/db/v2-queries.ts:3319`)
   chains `commitRows` → `gitToolCalls(commitCallSpan(...))` →
   `attributedCommits` and `openedPullRequests`.
4. `merged` is `locallyMergedPullRequests` OR GitHub `MERGED` about this PR.
5. Cost comes from `getUsageRows` (`src/db/v2-queries.ts:4267`), keyed by the
   lowercased session key that `browserSessionKey` produces.

**Thinnest seams.**
- Collection: extend the existing pass. Landing is computed beside
  `readCommits` in `syncGitActivity`. The PR search is a second function in
  `github.ts`, called from `refreshGitActivity` after the state lookup and
  gated by the same `config.git.githubLookups`.
- Read: a new `getAnalyticsOutcomes` in `v2-queries.ts` reusing the commit
  and PR helpers, with the allocation and pooling as pure functions in a new
  `src/analytics/outcomes.ts`, so they test without a database.

**Traps the exploration hit, each of which gave plausible numbers.** Each is
pinned by a test.
1. A Codex session has an import row and a rollout row under one session key.
   Keying by browser row double-counts cost, and tool calls sit on one row
   only. Key everything by `browserSessionKey`.
2. Zone-less stored times are UTC. A non-UTC parse shifted every call 4-5 h
   off GitHub's `createdAt`.
3. Delegated work rolls up to its root through `parent_session_id`. Whether a
   root is observable is a test on the root's tool calls, not each child's.
4. A fork's `origin` is upstream (`git_repos.github_repo` comes from
   `originGithubRepo`). Landing must consider every remote's default branch.
   Checking origin alone misclassified 12% vs 2%.

**Sibling paths that must agree.**
- The Git sub-view's existing PR "merged" counts (`openedPullRequests`)
  should become consistent with the new membership. A PR merged per
  `github_pull_requests` stays the single answer; the search upserts into the
  same table rather than a second state store.
- The session viewer's Git line keeps its semantics.
- `syncSessionPullRequests` keeps skipping PRs already known merged, so the
  search filling them doesn't cause rechecks.
- Router-error tests, the frontend client mirror and the store panel list
  each need the new route.

## Task Breakdown

### Task 1: Schema v29

**Objective**

Store PR size, author and commits, and each commit's landing.

**Files**

- Modify: `src/db/schema.ts`
- Modify: every test asserting the current `user_version` (15 files: `grep -rl "pragma('user_version', { simple: true }), 28)" tests`), 28 → 29
- Test: `tests/git-outcome-schema.test.ts`

**Dependencies**

None

**Assumptions Verified**

- `src/db/schema.ts:255` creates `github_pull_requests(repo, number, state, merged_at, created_at, checked_at)`.
- `src/db/schema.ts:804-808` adds `git_repos.github_repo` with a `PRAGMA table_info` guard. New columns follow that pattern.
- `src/db/schema.ts:1199` has `DATA_SCHEMA_VERSION = 28`. The comment at `:1263` records additive-only versions.
- Fifteen test files assert `user_version` 28 after an upgrade (grep observed 2026-11-03).

**Implementation Steps**

1. Add guarded columns:
   - `github_pull_requests`: `additions`, `deletions`, `changed_files`, `commit_count`, `author_is_bot`, `details_at`;
   - `git_commits`: `landing` ('direct' | 'merged' | NULL).
2. Create `github_pull_request_commits(repo, number, sha, source CHECK (source IN ('github','local')), PRIMARY KEY (repo, number, sha))` with an index on `sha`.
3. Create `github_pull_request_search(window_start PRIMARY KEY, synced_at, result_count)`, a per-window watermark.
4. Bump to 29 and extend the additive-versions comment.

**Verification**

- Run: `node --import tsx --test tests/git-outcome-schema.test.ts`
- Expect: a v28 database upgrades to 29 with the new columns and tables, and existing rows are unchanged.

**Test Discovery Verified**

- `scripts/test/run-node-tests.mjs` runs `tests/**/*.test.ts`. The version-pinning files are in that tree.

**Done When**

- Upgrading a v28 fixture adds the columns and tables, keeps every row, and sets `user_version` 29.
- A fresh database gets the same shape.

### Task 2: Landing and local PR membership from git

**Objective**

Each stored commit knows whether it landed, and merge commits give PR
membership without GitHub.

**Files**

- Modify: `src/git/activity.ts`
- Test: `tests/git-activity.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/git/activity.ts:116` `readCommits` reads `%P` only to compute `is_merge`. Membership asks git for a merge's parents instead, so no parents column is stored.
- `syncGitActivity` (`:157`) runs one transaction per repository; landing slots in after the upsert.
- `originGithubRepo` (`:107`) reads `origin` only, which is upstream for a fork (observed in the exploration).

**Implementation Steps**

1. For each repository, take every remote's default branch: `refs/remotes/<remote>/HEAD`, else `<remote>/main`, then `<remote>/master`, else the local `main` or `master`.
2. Set landing for stored commits whose `landing` is NULL or that are in the reread window:
   - `direct`: on some main's `--first-parent` line;
   - `merged`: reachable from a main otherwise;
   - NULL otherwise.

   Bound the `rev-list` walks with `--since-as-filter` at the oldest unlanded commit, so a branch merged weeks later is picked up.
3. For a stored merge commit whose subject names PR #N (`mergedPullRequestNumber`) and whose PR has no membership yet, insert `github_pull_request_commits` rows (`source='local'`) for `rev-list <sha>^1..<sha>^2`, asked of git directly so merges stored before v29 are covered too. Key the PR by the GitHub repository of the remote whose main carries the merge on its first-parent line (a fork's merges are the fork's PRs), else origin's. Never write over `source='github'` rows.

**Verification**

- Run: `node --import tsx --test tests/git-activity.test.ts`
- Expect, in a temp-repo fixture:
  - a commit pushed to main is `direct`;
  - a branch merged by merge commit is `merged`;
  - an unmerged branch is NULL;
  - a commit on a second remote's main (fork) is `direct`;
  - a branch merged after an earlier pass is `merged` on the next pass;
  - PR #N's branch commits are listed `local`.

**Test Discovery Verified**

- `tests/git-activity.test.ts` exists and builds temp repositories, which it removes in `after()`, as the runner requires.

**Done When**

- All six fixture cases hold.
- Making landing check only `origin` turns the fork case red.
- Dropping the reread of unlanded commits turns the late-merge case red.

### Task 3: The maintainer's merged PRs from GitHub

**Objective**

When lookups are on, record every merged PR the signed-in user authored: its
size, whether a bot authored it, and its commits. This covers PRs no session
opened, and provides the coverage denominator.

**Files**

- Modify: `src/git/github.ts`, `src/git/service.ts`, `src/cli/commands/maintenance.ts` (`amon sync git`)
- Test: `tests/github-pull-requests.test.ts`

**Dependencies**

Task 1

**Assumptions Verified**

- `src/git/github.ts:47` `lookupQuery` admits only `[\w.-]+/[\w.-]+` names and safe integers into a query.
- `parseLookupResponse` treats only NOT_FOUND as a null answer.
- `PullRequestLookup` is injectable (`options.lookup`), so tests need no network.
- `src/git/service.ts:18` gates GitHub work on `config.git.githubLookups`.

**Behavior Measured**

- 2026-11-03, `gh` signed in, GraphQL `search(type: ISSUE, query: "is:pr is:merged author:@me merged:2026-10-01..2026-10-31")`:
  - returned `issueCount` 353 and `hasNextPage` true;
  - nodes carried `repository.nameWithOwner`, `additions`, `changedFiles`, `author.__typename` "User" and `commits.totalCount` with `oid`s;
  - `rateLimit.cost` was 1.

**Implementation Steps**

1. Add `searchQuery(window, cursor)` and `parseSearchResponse(body)` as pure functions, like `lookupQuery` and `parseLookupResponse`.
2. Add `syncAuthoredPullRequests(db, { search?, now? })`:
   - walk month windows over the last year, oldest unsynced first;
   - re-search the current and previous month every pass, and earlier windows only when unsynced;
   - split any window whose `issueCount` exceeds 1,000;
   - page 100 at a time;
   - upsert `github_pull_requests` (state, times, size, `author_is_bot`, `details_at`) and `github_pull_request_commits` (`source='github'`, replacing any `local` rows for that PR);
   - record each window in `github_pull_request_search`.
3. Extend the existing state lookup's fields with size and `commits(first: 100)` too, so session-opened PRs by other authors get membership.
4. A PR with more than 100 commits keeps `commit_count` and its first 100. The read reports the count of such PRs as a coverage note.
5. Call it after `syncSessionPullRequests` in `refreshGitActivity` and in `amon sync git`, and report windows, PRs and unanswered requests.

**Verification**

- Run: `node --import tsx --test tests/github-pull-requests.test.ts`
- Expect, with an injected search:
  - a window over 1,000 splits;
  - pages are followed;
  - a partial response records what it holds and leaves the rest unsynced;
  - a merged PR already stored is not asked about again by the state lookup;
  - `local` membership is replaced by `github` membership;
  - an injection-shaped repository name never reaches a query.

**Test Discovery Verified**

- `tests/github-pull-requests.test.ts` exists in the runner's tree. Execution of the new cases is planned, not observed.

**Done When**

- Each case above passes.
- Removing the window split, or the page follow, turns a test red.
- With lookups off, no `gh` process starts (spy on the injected search).

### Task 4: Allocation and the outcomes read

**Objective**

Answer, for a range and the global filters: where spend went, cost per merged
PR (median, p25/p75/p90, all-in), a weekly trend with tokens per PR and
$/Mtok, size buckets, pooled projects, and coverage.

**Files**

- Create: `src/analytics/outcomes.ts` (pure: allocation, buckets, pooling)
- Modify: `src/db/v2-queries.ts` (`getAnalyticsOutcomes`, a shared helper for the commit and PR chain), `src/api/v2/types.ts`, `src/analytics/responses.ts`, `src/api/v2/router.ts`
- Test: `tests/analytics-outcomes.test.ts`, `tests/outcomes-allocation.test.ts`, `tests/v2-router-errors.test.ts`

**Dependencies**

Tasks 2 and 3

**Assumptions Verified**

- `getAnalyticsGitActivity` (`src/db/v2-queries.ts:3319`) builds `commitRows` → `gitToolCalls` → `attributedCommits` / `openedPullRequests`. The outcomes read reuses that chain through one extracted helper rather than a copy.
- `getUsageRows` (`:4267`) returns `session_id`, `agent_type`, `cost_usd`, the four token fields (`tokens_in` is uncached input for both agents: `src/import/codex.ts:306`) and `timestamp`.
- `browsing_sessions.parent_session_id` links Claude and Codex subagents (observed: every `subagent` row has one).
- Codex `internal` threads have none, so they stand as their own roots.

**Implementation Steps**

1. In `outcomes.ts`:
   - `allocate(minutes, milestones)` gives each minute of cost to the same root's first milestone at or after it (the "next" rule). With none after it, the minute counts as no outcome.
   - `sizeBucket(lines)` uses fixed buckets (<200, 200-499, 500-999, ≥1,000 lines), stable across ranges, unlike quartiles.
   - `poolProjects(groups)` applies empirical-Bayes shrinkage of mean log cost toward the overall mean. The weight is τ²/(τ² + σ²/n), with method-of-moments τ² floored at a small positive value.
2. `getAnalyticsOutcomes(params)`:
   - Bucket usage rows by root session key and minute, rolling children up via `parent_session_id` mapped through `browserSessionKey`.
   - Build milestones, which are each credited commit (with its PR via `github_pull_request_commits`, preferring a merged one) and each PR a session opened. Read milestones up to 30 days past the range end, so the next rule can reach them.
   - Classify each milestone:
     - landed via merged PR;
     - landed by direct push;
     - landed another way;
     - not landed (PR open or closed, or a commit on no main).
   - Cost with no milestone after it is "nothing after it"; cost in sessions without tool calls, or with no transcript, is "unobservable".
   - Respond with spend shares and dollars per class, merged-PR stats, weekly points (merged PRs, median dollars, median tokens per PR, $/Mtok), size buckets, pooled projects (n, median, pooled) and coverage:
     - share of cost observable;
     - when lookups are on, the user's merged PRs in range from `github_pull_requests` (bot authors excluded) and the share linked;
     - PRs with truncated commit lists;
     - which source membership came from.
3. Route `/analytics/outcomes` with the shared analytics params; add a router-errors entry and a response wrapper.

**Verification**

- Run: `node --import tsx --test tests/outcomes-allocation.test.ts tests/analytics-outcomes.test.ts tests/v2-router-errors.test.ts`
- Expect, from fixture sessions, commits, PRs and usage:
  - a session's cost splits across its PRs by timeline;
  - a Codex session's two rows count once;
  - a subagent's cost rolls up to its parent;
  - a direct push lands;
  - an unmerged branch doesn't;
  - spend after the last milestone is "nothing after it";
  - pooled estimates move a 2-PR project further than a 40-PR one;
  - the project and agent filters narrow cost and milestones together.

**Test Discovery Verified**

- New files go in `tests/`, which the runner globs. Planned, not observed.

**Done When**

- Every expectation above passes.
- The class shares sum to 1 over the range's dollars, and those dollars equal Usage's total for the same params.
- Each of these mutations turns a test red: keying by browser row, skipping the parent rollup, splitting cost per session, unpooled projects, origin-only landing.
- On a store snapshot, a 30-day read takes ≤1 s warm and reproduces the exploration's class shares within rounding (recorded in the PR, as ratios).

**Result (2026-11-04, PR 2)**

- Done as planned, with two refinements found while testing:
  - Whether a commit's pull request merged comes from GitHub's word or a local merge. A session's own opening of a pull request is judged by git activity's rule, which knows when GitHub's answer is about another pull request that reused the name. GitHub's commit list belongs to the pull request GitHub answered about.
  - A pull request merged in the range costs what was allocated to it from up to 30 days before the range, so the range's own dollars (which match Usage's) and the PRs' costs are read separately.
- Snapshot: class shares within a point of the exploration, monthly medians within 2%, a 30-day read about 0.5 s warm.

### Task 5: The Cost per outcome section

**Objective**

Draw the outcomes read in the Git sub-view, with coverage beside each number.

**Files**

- Create: `frontend/src/lib/components/git/GitOutcomes.svelte`, `frontend/src/lib/outcome-chart.ts`
- Modify: `frontend/src/lib/components/git/GitPage.svelte`, `frontend/src/lib/stores/analytics.svelte.ts`, `frontend/src/lib/api/client.ts`
- Test: `frontend/src/lib/outcome-chart.test.ts`, `frontend/src/lib/stores/analytics.svelte.test.ts`, `e2e/analytics-views.spec.ts`

**Dependencies**

Task 4

**Assumptions Verified**

- `GitPage.svelte` mounts `analytics.initializeGit()` and refreshes `fetchGitActivity` every 5 minutes. The new fetch joins both.
- `frontend/src/lib/components/ui/chart/` provides `PlotFrame` (scales and ticks), `DailyBarChart` and `Sparkline`.
- The store's panels use a version guard per fetch (`fetchGitActivity` pattern).

**Implementation Steps**

1. The store gets an `outcomes` panel: fetched in `initializeGit` and in the refresh; re-fetched on filter change through the `git` subscription mode.
2. Build the section:
   - headline tiles: median per merged PR, all-in per merged PR, share of spend that landed;
   - one 100% bar of where spend went, with the classes in a fixed order, a legend and direct labels on segments wide enough to hold them;
   - a weekly median line in `PlotFrame` with a p25-p75 band;
   - tokens per PR and $/Mtok as two separate small charts (one axis each, never a dual axis);
   - size-bucket bars;
   - a project table: PRs, median, pooled, sorted by PRs;
   - a coverage line ("63% of your merged PRs this range are linked to a session here"), and a note when membership is local-only.
3. Label the section as inferred, like friction: allocation follows the session's timeline, and "nothing after it" isn't waste.
4. Pick categorical colors per the chart rules, validate the palette script for light and dark, and add a table fallback for the bar and trend.

**Verification**

- Run: `pnpm frontend:check && pnpm frontend:test && pnpm exec playwright test e2e/analytics-views.spec.ts`
- Expect:
  - transforms keep the class order and colors stable when a class is empty;
  - the store refetches on a filter change;
  - the E2E opens the Git view and sees the section's headline and coverage line;
  - screenshots at 1440 and 390 px show no overflow and no console errors.

**Test Discovery Verified**

- Vitest runs `frontend/src/**/*.test.ts`; Playwright runs `e2e/*.spec.ts` (both observed in earlier gates).

**Done When**

- Each check above passes.
- A class missing from one range doesn't repaint the others (tested).
- The section renders a clear empty state when no PR merged in range.

**Result (2026-11-04, PR 3)**

- Done as planned. The section sits below Commits and Latest Pull Requests. The weekly median and its middle half, tokens per PR, and dollars per million tokens are three small charts, each on its own axis, with a weekly table beside them.
- The bar's six classes use five series of the shared validated palette, plus Other for spend that can't be followed. `tests/series-palette.test.ts` already checks every pair of those on the dark surface.
- Screenshots at 1440 and 390 px against a store snapshot: no overflow, no console errors.

### Task 6: Docs

**Objective**

Owning references describe the behavior, coverage and outbound traffic. The
collection's own statements (README outbound list, ARCHITECTURE tables,
OPERATIONS pass, FEATURES privacy bullet) land with PR 1, which changes them;
this task covers the read and the view.

**Files**

- Modify: `docs/system/FEATURES.md`, `docs/system/ARCHITECTURE.md`, `docs/system/OPERATIONS.md`, `README.md`, `docs/project/BACKLOG.md`

**Dependencies**

Tasks 2-5

**Assumptions Verified**

- `README.md:219` holds the "What can leave your machine" list that #250 and #251 extended.
- `src/cli/commands/maintenance.ts:281` defines `sync git`, whose summary OPERATIONS quotes.

**Implementation Steps**

1. FEATURES:
   - landing and allocation rules, inferred labeling, and coverage;
   - what lookups-off loses (squash-merged membership, the coverage denominator);
   - the unidentifiable "split vs cheaper" caveat.
2. ARCHITECTURE: the v29 tables and columns, and the collection order in a pass.
3. OPERATIONS: the `amon sync git` report; the fact that landing reflects the last fetch.
4. README "What can leave your machine": the search lists the signed-in user's merged PRs across GitHub when lookups are on.
5. BACKLOG: revert detection ("still standing"), the Claude vs Codex comparison, and quota as the unit, each with a revisit trigger.

**Verification**

- Run: `git diff main -- docs README.md | grep -E '\$[0-9]'`, plus a read of the diff for repository names
- Expect: no dollar figures, and no maintainer repository named outside generic examples.

**Done When**

- Every statement above is in its owning doc.
- Backlog entries carry a What, a Why and a revisit trigger.

## Risks And Mitigations

- **Risk:** GitHub search can drop or reorder results under load, or change its 1,000-result cap.
  - **Signal:** a window's stored count is below its `issueCount`.
  - **Mitigation:** compare per window and leave short windows unsynced for the next pass. The coverage line uses `issueCount`, not stored rows.
- **Risk:** the in-product allocation is slower than the exploration's DuckDB pass on a large store.
  - **Signal:** the Task 4 timing gate (≤1 s warm for 30 days) fails.
  - **Mitigation:** cache per-minute buckets per range key for the refresh interval, or precompute milestones per pass into a table. Decide on the measurement.
- **Risk:** stale remote-tracking refs make recent work look "not landed".
  - **Signal:** not-landed spend clustered in the last days of a range.
  - **Mitigation:** FEATURES and the section note that landing reflects the last fetch; the coverage line shows when membership was last synced.
- **Risk:** PRs authored by someone other than the user, or by a bot account an agent used, are missed by `author:@me`.
  - **Signal:** session-opened PRs whose details never arrive.
  - **Mitigation:** the state lookup fetches details for session-opened PRs whoever authored them (Task 3 step 3).

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| v29 upgrades in place | `node --import tsx --test tests/git-outcome-schema.test.ts` | v28 fixture → 29, rows intact |
| Landing across remotes, late merges | `node --import tsx --test tests/git-activity.test.ts` | six fixture cases pass; origin-only mutation red |
| Authored PR search, windows, pages | `node --import tsx --test tests/github-pull-requests.test.ts` | split, paging, partial, no-`gh`-when-off pass |
| Allocation and read | `node --import tsx --test tests/outcomes-allocation.test.ts tests/analytics-outcomes.test.ts` | timeline split, key dedupe, rollup, pooling; shares sum to 1; dollars equal Usage |
| Route and errors | `node --import tsx --test tests/v2-router-errors.test.ts` | new route's 500 entry passes |
| Built path | `pnpm build && pnpm verify:skill-context-built && pnpm exec playwright test` | pass, including the Git section |
| UI | `pnpm frontend:check && pnpm frontend:test` | 0 errors; transforms and store tests pass |
| Real data | snapshot read, recorded in the PR | class shares match the exploration; 30-day read ≤1 s warm |

## Handoff

Deliver as three PRs, each with Codex review:
1. Tasks 1-3 (collection).
2. Task 4 (read).
3. Tasks 5-6 (UI and docs).

Branch from main in `~/Dev/.worktrees/agentmonitor-<task>`. The exploration
worktree (`agentmonitor-cost-outcome`) holds uncommitted exports only and is
removed before Task 1.
