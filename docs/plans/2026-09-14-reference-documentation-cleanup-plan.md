---
date: 2026-09-14
author: gpt-6
topic: reference-documentation-cleanup
stage: plan
status: complete
source: conversation
risk_profile: routine
readiness: ready
---

# Reference Documentation Cleanup Plan

## Goal

Turn AgentMonitor's tracked reference documentation into a compact, reliable
agent-facing information system. Source, tests, CLI help, and live GitHub settings
remain authoritative for exact mechanics; tracked docs preserve durable intent,
system boundaries, external contracts, operator procedures, decisions, and future
work without duplicating volatile inventories or Git history.

The end state is:

- every retained document has a distinct purpose that is useful to a maintainer or
  a zero-context agent;
- known factual drift against the current source and repository settings is fixed;
- `docs/project/CURRENT_STATE.md` and `docs/system/tier-feedback.md` are removed
  after their unique durable content is folded into the owning references;
- the Roadmap describes current direction instead of serving as a long-form
  changelog;
- endpoint, command, environment-variable, schema, and directory inventories defer
  to executable authority unless they express a stable external contract; and
- all tracked links and the repository's pre-push checks pass.

## Scope

### In Scope

- Reconcile the floating `docs/clone-mining-agentsview-findings` backlog commit
  onto the cleanup branch and prune the obsolete branch.
- Correct and simplify tracked references under `docs/system/`, `docs/project/`,
  and `docs/api/`.
- Update `docs/README.md`, the root `README.md`, and `AGENTS.md` wherever the
  revised ownership model or retired documents affect navigation and guidance.
- Align the public event-ingest documentation and runtime validation for the
  closed `source` enum.
- Preserve durable privacy, fidelity, recovery, configuration, and product-scope
  boundaries while removing duplicated implementation history.

### Out of Scope

- Product features, UI redesign, API expansion, or database migrations.
- Resolving the newly imported cross-repository backlog candidates; those remain
  hypotheses until separately grounded against current source and runtime data.
- Generating a complete OpenAPI document, CLI reference, configuration reference,
  or schema catalog in this pass.
- Changing the existing archive convention for completed designs, specs, and plans.
- Changing the product's 60-day data defaults or introducing a latency SLO.

## Assumptions And Constraints

- This is a routine documentation and narrow contract-correction change. Its sole
  runtime behavior change is rejection of `source` strings outside the existing
  TypeScript `EventSource` union.
- Reference documents that are retired are deleted after their useful content and
  inbound links move. They are not kept as invisible untracked copies.
- Exact route lists belong to `src/api/v2/router.ts`; exact CLI flags belong to
  `amon --help`; exact configuration parsing belongs to `src/config.ts`; exact
  database structure belongs to `src/db/schema.ts`; current repository settings
  belong to the GitHub API.
- API documentation remains valuable for externally consumed semantics such as
  validation, timestamp behavior, privacy, error behavior, and compatibility.
- The existing `docs/archive/` convention applies to completed pipeline artifacts,
  not retired evergreen reference files. Git history is sufficient for the latter.
- The project working agreement requires coherent commits and full pre-push checks
  because a TypeScript contract file will change.

## Map Before You Cut

The documentation path begins at `AGENTS.md`, the root `README.md`, and
`docs/README.md`. Those files route maintainers into three distinct reference
families:

- `docs/system/`: current product behavior, system shape, design intent, and
  operator procedures;
- `docs/project/`: positioning, direction, durable decisions, and future work;
- `docs/api/`: compatibility boundaries and externally consumed contracts.

The thinnest seam is to keep this directory structure, sharpen the ownership of
each retained file, and remove the two references whose responsibilities are
already owned elsewhere. No new umbrella document is needed because `AGENTS.md`
and `docs/README.md` already provide routing surfaces.

The defect class is manually mirrored, high-change fact inventories. It appears in
the API endpoint tables, the Architecture schema/directory map, the Operations
command and environment-variable catalog, Current State, and the Roadmap's shipped
history. Each is addressed explicitly below. Durable semantic material such as
coverage honesty, non-enforcement, recovery boundaries, and declined decisions is
retained even when adjacent inventory prose is removed.

## Task Breakdown

### Task 1: Preserve The Floating Backlog Work

**Objective**

Bring the cross-repository pattern-mining candidates onto the fresh cleanup branch
without overwriting newer backlog work, then remove the obsolete branch pointers.

**Files**

- Modify: `docs/project/BACKLOG.md`

**Dependencies**

None

**Assumptions Verified**

- Commit `64cadbed05f18c26e0ef481be6eff18fdbfc7c89` modified
  `docs/project/BACKLOG.md` and diverged from `main` before the recent CLI,
  performance, and archive merges (verified 2026-09-14 with `git show` and
  `git log --left-right main...docs/clone-mining-agentsview-findings`).
- The additions label all three mined patterns as unverified hypotheses and cite
  their external report, so preservation does not falsely promote them to current
  repository facts.

**Behavior Measured**

- `git cherry-pick 64cadbed05f18c26e0ef481be6eff18fdbfc7c89` completed without
  conflicts as commit `cc37681` on `docs/reference-docs-cleanup`.
- The obsolete local and remote `docs/clone-mining-agentsview-findings` branches
  were deleted after the commit was preserved on the cleanup branch.

**Implementation Steps**

1. Cherry-pick the backlog commit onto the fresh branch.
2. Confirm the imported text remains evidence-labeled and future-only.
3. Delete the obsolete local and remote branch references.

**Verification**

- Run: `git show --stat cc37681`
- Expect: `docs/project/BACKLOG.md` is the complete changed-file set, with the mined
  candidates present.
- Run: `git branch --all --list '*clone-mining-agentsview-findings*'`
- Expect: no matching local or remote-tracking branch.

**Done When**

- All four additions from the floating commit are preserved exactly once on the
  cleanup branch and the obsolete branch no longer exists locally or on GitHub.

### Task 2: Establish Durable Documentation Ownership

**Objective**

Make the agent-facing navigation explain which authority owns each kind of fact,
and remove references to documents that will be retired.

**Files**

- Modify: `AGENTS.md`
- Modify: `docs/README.md`
- Modify: `README.md`

**Dependencies**

Task 1

**Assumptions Verified**

- `AGENTS.md:18-31` describes several documents as exhaustive catalogs and links
  `docs/project/CURRENT_STATE.md` as a separate high-change authority.
- `docs/README.md:13-35` links both retirement candidates and describes the system
  references by their current inventory-heavy roles.
- `README.md:202-209` links `CURRENT_STATE.md`, while `README.md:213-216` still says
  direct `/` serves the removed legacy dashboard.

**Implementation Steps**

1. Rewrite the documentation map around semantic ownership: Architecture for
   topology and invariants, Features for observable behavior, Operations for
   procedures and recovery, Project for direction/decisions/future work, and API
   for externally consumed contracts.
2. State where exact routes, commands, configuration, schema, and repository
   settings are authoritative.
3. Remove links to `CURRENT_STATE.md` and `tier-feedback.md`; route their retained
   content to Operations and Features.
4. Correct the root-path behavior in the root README.

**Verification**

- Run: `rg -n 'CURRENT_STATE\.md|tier-feedback\.md|legacy /.*compatibility|full v1/v2 API endpoint catalog|all AGENTMONITOR' AGENTS.md README.md docs/README.md`
- Expect: no stale links or claims remain.

**Done When**

- A zero-context agent can identify one owning reference for each documentation
  concern without treating manually mirrored inventories as executable authority.

### Task 3: Correct The External Event Contract

**Objective**

Make the ingest documentation complete for accepted fields and make runtime
validation enforce the closed `EventSource` contract already expressed by the
TypeScript type.

**Files**

- Modify: `src/contracts/event-contract.ts`
- Modify: `tests/event-contract.test.ts`
- Modify: `docs/api/event-contract.md`
- Modify: `docs/api/README.md`

**Dependencies**

Task 2

**Assumptions Verified**

- `src/contracts/event-contract.ts:22-31` defines `api`, `hook`, `otel`, `import`,
  and `benchmark` as the complete `EventSource` union, but line 222 casts any
  optional string to that union without membership validation.
- `tests/event-contract.test.ts:132-157` verifies known sources and omission but
  has no invalid-source case.
- `docs/api/event-contract.md:23-36` omits `model`, `cost_usd`, cache token fields,
  and `source`, despite the runtime accepting them.
- `docs/api/README.md:17-23` is an incomplete endpoint inventory while line 25
  already points to the canonical route source.

**Implementation Steps**

1. Add a failing behavior test proving an unknown string source is rejected with a
   field-specific validation error.
2. Add source normalization parallel to event-type/status normalization, then run
   the focused test green.
3. Document every accepted optional field, the source enum, defaults, and existing
   timestamp/batch behavior.
4. Reduce the API index to stable API families and direct readers to route source
   for the exact current list.

**Verification**

- Run red then green: `pnpm exec tsx --test tests/event-contract.test.ts`
- Expect: the new unknown-source assertion fails before implementation and the
  complete file passes afterward.

**Test Discovery Verified**

- `package.json` runs `tsx --test tests/*.test.ts`, which includes
  `tests/event-contract.test.ts`.
- Literal proof: `pnpm exec tsx --test tests/event-contract.test.ts` executes that
  file directly.

**Done When**

- The documented optional-field set matches `NormalizedIngestEvent`; the five
  declared sources (`api`, `hook`, `otel`, `import`, `benchmark`) are accepted; and
  the test's `custom` source is rejected as invalid.

### Task 4: Repair And Simplify System References

**Objective**

Keep the valuable system model while removing stale implementation history and
volatile catalogs.

**Files**

- Modify: `docs/system/ARCHITECTURE.md`
- Modify: `docs/system/DESIGN.md`
- Modify: `docs/system/FEATURES.md`
- Modify: `docs/system/OPERATIONS.md`
- Modify: `docs/system/trace-quality.md`
- Modify: `docs/system/usage-budgets.md`
- Delete: `docs/system/tier-feedback.md`

**Dependencies**

Tasks 2 and 3

**Assumptions Verified**

- `docs/system/ARCHITECTURE.md:93-105` describes a removed persisted
  `trace_quality_*` warehouse and says all SQL lives in the v1 query module;
  `src/db/schema.ts`, `src/db/v2-queries.ts`, and the lean trace-quality section
  show the current ownership.
- `docs/system/ARCHITECTURE.md:23` links an untracked local archive target, and its
  directory map describes removed trace-quality modules.
- `docs/system/FEATURES.md:60-64` understates live Codex OTEL usage, and its API
  table duplicates but does not fully match `src/api/v2/router.ts`.
- `docs/system/OPERATIONS.md:22-26` incorrectly gives direct `/` different behavior
  from the Portless root, and its CI section omits the protected Playwright check.
- `docs/system/DESIGN.md` omits `--color-antigravity`, which exists at
  `frontend/src/app.css:37`.
- `docs/system/tier-feedback.md` consists of endpoint mechanics plus two durable
  boundaries already suited to the Usage section of Features: content-free inputs
  and mandatory human review.
- `docs/system/trace-quality.md` and `docs/system/usage-budgets.md` hold durable
  semantic, privacy, export, and non-enforcement boundaries worth retaining.

**Behavior Measured**

- `git diff --check` exits zero on the reconciled branch before the documentation
  edits (verified 2026-09-14), establishing a clean whitespace baseline.

**Implementation Steps**

1. Reduce Architecture to current topology, data ownership, ingestion/read flows,
   runtime boundaries, critical invariants, and recovery relationships. Link
   canonical source entrypoints instead of reproducing exact schema and directory
   inventories.
2. Reduce Features to user-visible capabilities and fidelity/privacy semantics.
   Correct Codex usage capture and replace the endpoint catalog with family-level
   links.
3. Refocus Operations on workflows, runtime ownership, backup/recovery, integration
   setup, and verification. Correct root and CI behavior; direct exact CLI and
   configuration lookup to executable sources while retaining high-value examples.
4. Add the Antigravity design token and verify the remaining design semantics
   against `frontend/src/app.css`.
5. Fold tier-feedback's content-free and human-review boundaries into Features,
   then delete the standalone file.
6. Trim duplicated endpoint/command details from trace quality while retaining its
   lean-projection, privacy, coverage, and export contracts. Keep Usage Budgets as
   the operator-facing configuration contract.

**Verification**

- Run: `rg -n 'trace_quality_\*|All SQL lives|scores, prompts, findings|legacy compatibility dashboard|Via import backfill' docs/system`
- Expect: no stale implementation claims remain.
- Run: `git diff --check`
- Expect: no whitespace errors.

**Done When**

- Each system reference answers a distinct semantic or operational question, and
  none claims a removed UI, removed trace warehouse, single SQL module, or
  Codex usage path limited to imports.

### Task 5: Repair And Prune Project References

**Objective**

Keep project intent and future work durable while moving current behavior to system
references and completed implementation detail to Git/PR history.

**Files**

- Modify: `docs/project/BACKLOG.md`
- Delete: `docs/project/CURRENT_STATE.md`
- Modify: `docs/project/GIT_HISTORY_POLICY.md`
- Modify: `docs/project/POSITIONING.md`
- Modify: `docs/project/ROADMAP.md`
- Review: `docs/project/DECISIONS.md`

**Dependencies**

Tasks 1, 2, and 4

**Assumptions Verified**

- `docs/project/CURRENT_STATE.md` duplicates Features, Architecture, Operations,
  and Roadmap; its unique session-browser recovery procedure belongs in Operations.
- `docs/project/ROADMAP.md:5-309` is completed implementation history, while the
  actual current direction begins at line 310.
- `docs/project/GIT_HISTORY_POLICY.md:9-14` disagrees with the repository's live
  merge-message settings, and its required-check list omits `E2E (Playwright)`.
- `docs/project/POSITIONING.md:29-34` and lines 71-86 describe the removed local
  trace warehouse as current, while `docs/system/trace-quality.md` records the
  shipped lean projection and separate aggregate warehouse export.
- `docs/project/BACKLOG.md:118-134` predates the latest source-count optimization;
  lines 144-151 describe the Monitor's main read path as v1 even though
  `frontend/src/lib/api/client.ts` uses `/api/v2/monitor/*` and separately joins
  live occupancy.
- `docs/project/DECISIONS.md` contains two bounded negative decisions with evidence
  and revisit triggers; both remain current and need no structural change.

**Behavior Measured**

- Live GitHub settings queried 2026-09-14 report merge commits and rebase merges
  enabled, squash disabled, branch deletion enabled, merge title
  `MERGE_MESSAGE`, merge message `PR_TITLE`, strict required checks
  `Lint, Build, Test` and `E2E (Playwright)`, conversation resolution enabled, and
  zero required approvals.

**Implementation Steps**

1. Update the Usage overview backlog item with the shipped 2026-09-13 measurement,
   preserve the imported sibling-cache reference, and state that 150 ms is a
   historical trigger rather than an SLO. Correct the Monitor occupancy wording
   and repair misplaced section headings.
2. Move any unique recovery guidance out of Current State, then delete the file.
3. Rewrite Git History Policy as intended policy plus a dated verification method;
   correct the current remote settings and required checks.
4. Update Positioning for the shipped lean trace-quality model, the existing
   aggregate warehouse export, and the meaning of agent-native collection without
   embedded application SDK instrumentation.
5. Replace Roadmap's long Completed Highlights section with a short recent-milestone
   list and preserve Now, Next, Later, and working principles as its center.
6. Confirm Decisions remains future-relevant and free of changelog material.

**Verification**

- Run: `rg -n 'currently ~half the database|three overlapping representations|150 ms warm trigger|cards read the v1 store|CURRENT_STATE\.md' docs/project/*.md AGENTS.md README.md docs/README.md --glob '!docs/project/CURRENT_STATE.md'`
- Expect: no stale claims or retired-document links remain.
- Run: `gh api repos/davisbuilds/agentmonitor --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge,merge_commit_title,merge_commit_message}'`
- Expect: the observed settings match the dated policy snapshot.
- Run: `gh api repos/davisbuilds/agentmonitor/branches/main/protection --jq '{strict:.required_status_checks.strict,contexts:.required_status_checks.contexts,conversations:.required_conversation_resolution.enabled,approvals:.required_pull_request_reviews.required_approving_review_count}'`
- Expect: the documented protected checks and review settings match GitHub.

**Done When**

- Project docs have one owner for positioning, direction, decisions, and future
  work; no tracked current-state digest or long-form shipped changelog remains.

### Task 6: Validate The Tracked Documentation Set

**Objective**

Prove that the resulting tree is internally navigable, source-consistent at its
declared authority seams, and safe to review.

**Files**

- Modify as required by findings: retained files listed in Tasks 2-5

**Dependencies**

Tasks 2-5

**Assumptions Verified**

- The repository has no dedicated tracked-link checker, while the workspace archive
  tool detects links to archivable documents and requires `--apply` to stage moves.
- The standard pre-push path is `pnpm lint`, `pnpm build`, and `pnpm test`; the
  frontend-specific checks are unnecessary unless frontend TypeScript/Svelte files
  change.

**Behavior Measured**

- `python3 ~/Dev/ops/scripts/archive_docs.py agentmonitor` is the workspace-standard
  non-mutating archive audit for this repository.

**Implementation Steps**

1. Scan tracked Markdown relative links and fail on missing or untracked targets.
2. Search for the known stale phrases and retired filenames.
3. Run the archive script in dry-run mode and review, without moving this active
   in-progress plan.
4. Run the focused event-contract test, then the repository pre-push checks.
5. Review the final diff for duplicated inventories, lost semantic boundaries, and
   accidental changes outside the planned files.
6. Update this plan's status to `complete` after every gate passes; leave it
   tracked until the normal settling buffer makes it archive-eligible.

**Verification**

- Run: `git diff --check`
- Run: `python3 ~/Dev/ops/scripts/archive_docs.py agentmonitor`
- Run: `pnpm exec tsx --test tests/event-contract.test.ts`
- Run: `pnpm lint`
- Run: `pnpm build`
- Run: `pnpm test`
- Expect: all commands pass; the archive audit does not classify this plan as
  eligible while it is active.

**Done When**

- All retained tracked Markdown links resolve to tracked files, both retirement
  candidates are absent, the focused contract test and all three pre-push checks
  pass, and every changed file appears in the plan's file lists.

## Risks And Mitigations

- Risk: trimming a catalog could remove a semantic boundary that source does not
  explain. Signal: deleted prose describes privacy, fidelity, recovery, authority,
  or a negative decision rather than a list of current mechanics. Mitigation: move
  that statement into the owning retained reference before deleting surrounding
  inventory.
- Risk: strict source validation could reject a private client sending an
  undocumented custom source. Signal: repository fixtures, hooks, importers, or
  the live database contain a source outside the declared union. Mitigation: search
  all producers and inspect distinct local values before landing the validator; if
  custom values are intentional, widen the explicit enum and document them rather
  than retaining an unchecked cast.
- Risk: the Roadmap becomes too terse to explain recent strategic changes. Signal:
  a current focus area depends on a shipped decision that has no durable home.
  Mitigation: retain a concise milestone with a PR/date and move durable rationale
  to Positioning or Decisions.
- Risk: the imported clone-mining hypotheses become stale before investigation.
  Signal: source inspection disproves a candidate. Mitigation: keep their evidence
  label and remove or rewrite them during the next backlog audit once verified.

## Verification Matrix

| Requirement | Proof command | Expected signal |
| --- | --- | --- |
| Floating backlog work is preserved and old branch pruned | `git show --stat cc37681 && git branch --all --list '*clone-mining-agentsview-findings*'` | Backlog commit changes `docs/project/BACKLOG.md`; branch query is empty |
| Retired references are fully removed | `rg -n 'CURRENT_STATE\.md|tier-feedback\.md' AGENTS.md README.md docs/README.md docs/system docs/project --glob '!docs/plans/**'` | No matches |
| Event source contract is closed and tested | `pnpm exec tsx --test tests/event-contract.test.ts` | Known values pass and unknown source fails validation |
| Known stale architecture/product claims are gone | `rg -n 'trace_quality_\*|All SQL lives|Via import backfill|legacy compatibility dashboard' docs/system README.md` | No stale matches |
| Remote policy snapshot is current | `gh api` commands in Task 5 | Values equal the documented 2026-09-14 snapshot |
| Links and lifecycle are sound | tracked-link scan plus `python3 ~/Dev/ops/scripts/archive_docs.py agentmonitor` | No broken tracked links; active plan remains active |
| Repository quality gates pass | `pnpm lint && pnpm build && pnpm test` | All commands exit zero |

## Handoff

Completed on `docs/reference-docs-cleanup`:

- `cc37681` preserves the floating clone-mining backlog additions; the obsolete
  local and remote branch pointers were pruned.
- `2d60082` closes and documents the event-source enum after a red/green focused
  contract test.
- `0328cf3` sharpens documentation ownership, removes the two redundant references,
  corrects known drift, and reduces the tracked reference set by 973 net lines.
- The archive dry run reported `0 archivable, 0 need triage`; the tracked-link scan
  reported zero missing or untracked targets.
- `pnpm lint`, `pnpm build`, and all 912 `pnpm test` tests passed on 2026-09-14.

The plan remains tracked during the normal settling buffer. A later documentation
archive pass can move it into the local gitignored archive after it becomes
eligible.

Plan complete and saved to `docs/plans/2026-09-14-reference-documentation-cleanup-plan.md`.
