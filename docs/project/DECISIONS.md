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
