# Decision History

Durable decisions that are no longer active follow-ups. Keep the evidence needed
to revisit a decision, but do not use this file as a roadmap or changelog.

## Do not infer the Claude context window from the statusline bridge (2026-07)

**Decision:** retain the guarded 1M default rather than deriving a plan-specific
window from the statusline payload.

**Evidence:** the bridge forwards only `exceeds_200k_tokens`: a usage threshold,
not a numeric window or plan identifier. `true` merely confirms at least 1M for
the current default, while `false` is ambiguous between a 200K plan and a 1M plan
below 200K.

**Revisit when:** an ingested source exposes an authoritative numeric window or
200K-versus-1M plan identity.

## Do not batch the Analytics Overview fetches (2026-07-14)

**Decision:** do not add an `/api/v2/analytics/overview` endpoint solely to batch
the page's independent reads.

**Evidence:** on the 122K-row development database, each analytics endpoint
returned in 1–4 ms (about 14 ms total SQL). The Usage overview improvement removed
redundant coverage work; Analytics has no comparable repeated computation. The
same measurement ruled out the fan-out as the cause of the capability-banner E2E
flake, whose likely area is cold first navigation.

**Revisit when:** profiling finds material duplicated work or latency that a
combined read can eliminate; diagnose the E2E flake separately.

## Monitor filters by agent only (2026-10-15)

**Decision:** Monitor offers a single filter, Agent. Project, event type, tool,
model, branch, and source filtering live in Sessions and Analytics.

**Evidence:** Monitor's bar offered seven filters, but only Agent reached every
read. Project narrowed just the two cost figures; event type, tool, model,
branch, and source narrowed just the recent-event rows inside each agent card.
The stats strip (`/api/v2/monitor/stats`) takes only an agent and a start time,
and a project filter there would scan the events table without a matching index,
where the agent filter needed a dedicated index and plan test to stay fast. With
Monitor showing only what is running now, few cards remain to filter.

**Revisit when:** Monitor regularly shows enough concurrent sessions that
narrowing them by project matters. Then add project to the stats read with an
index measured on a snapshot (`verify probe plans`), and apply it to the cards
and live events in the same change. A `mode` facet would likewise want a
dedicated column rather than `json_extract` on `sessions.metadata`.

## Leave pre-fix Claude rows without a transcript as stored, and disclose (2026-10-29)

**Decision:** Claude rows imported before the 2026-09-22 per-turn billing fix
whose transcript is gone keep their stored usage and cost. FEATURES discloses
that Claude cost from before mid-July 2026 likely reads high. No heuristic
correction and no per-row marker for now.

**Evidence:** the importer then billed a turn once per content-block line.
`amon costs repair-claude-usage` corrects only rows whose transcript survives,
and transcripts restored from offsite backups reach back only to mid-July.
In the months they cover, the repeat lines were about half of July's checkable
imported cost and about a third of August's; that earlier months carry
similar inflation is a hypothesis. The alternatives each had a cost:

- Collapsing identical `(session, timestamp, usage)` tuples would recover most
  of the remainder, but it also collapses distinct turns that share a tuple. How
  often they do is unmeasured, so it trades a known overstatement for an
  unknown understatement.
- A provenance marker that labels these rows in the UI is honest, but it is a
  schema and read-path change across every cost surface. The disclosure gives
  the same warning without that change.

**Revisit when:** a decision rests on Claude cost from before mid-July 2026, or
older transcripts turn up. Measure how often distinct turns share a usage tuple
before any collapse; if a per-row warning is wanted instead, add the provenance
marker.

## Leave Claude Code OTEL export off (2026-10-27)

**Decision:** amon ingests Claude Code's OTEL metrics correctly, but the
installed Claude Code does not export them, and enabling export is not planned.
The import already covers what the metrics would add.

**Evidence:** measured on 2026-10-27 with Claude Code 2.1.311 against a scratch
database:

- Before the parser fix in the same PR, every metric row was stored under
  session `unknown` and every log record was dropped. Claude Code puts
  `session.id` on each point and record, not on the resource, so enabling
  export would have double-counted Claude cost permanently.
- With the fix, each session's metric cost equals its imported cost exactly,
  and the import covers every metric row once the transcript lands.
- Logs and metrics do not double-count: amon stores Claude's `api_request` log
  with no tokens or cost, because Claude sends `cost_usd` and `input_tokens`
  under plain names. A test pins "counted once" so a parser that learns those
  names must deduplicate.
- What enabling would add: a live lead of seconds over the file watcher, and
  usage for sessions whose transcript never reaches this machine. Claude's own
  cost is already checked through `cost-state` (`amon costs check-sessions`).
  Active time, lines changed, commits and edit decisions are exported but not
  stored.
- Space: about five rows per session, model and active export interval, each
  about 1 KB with indexes. At the measured activity that is roughly 7-15% more
  events rows a day, well under 1% of the database a month. Logs add about as
  many rows again with no usage in them. Prompts and responses arrive redacted
  by default; every point carries account identifiers, which amon does not
  store.

**Revisit when:** Claude runs where its transcripts do not reach this machine,
or active-time or edit-decision metrics are wanted (that also needs metric
ingestion beyond tokens and cost). Enable metrics only.
