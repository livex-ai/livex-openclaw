---
name: debug
description: Use when investigating production errors, timeouts, readiness failures, or suspected regressions from Slack alerts, log evidence, conversation IDs, jobs, rooms, or traces in the oncall agent.
---

# Production Debug

Use observed identifiers to obtain evidence before asking for infrastructure
labels. Services, revisions, namespaces, and pods can change. Discover them from
logs and preserve their provenance. Native Codex owns this workflow and decides
when its evidence answers the request; this skill adds no separate agent loop.

## 1. Plan coverage from the alert

Read the alert root and relevant replies. Extract the symptom, full alert window,
event times, and observed conversation/job/room/trace/log insert IDs. Preserve
identifiers and all 1–9 fractional timestamp digits. Distinguish event time,
Slack delivery time, query window, and evidence `retrievedAt` time.

Keep a compact query plan in the native conversation. Split the full alert window
into windows of at most one hour, with observed seed batches for each relevant
hour. Use exact alert insert IDs first (`insertIds`, 1–10 per batch), or the
available correlation IDs. Do not replace a multi-hour alert with a generic
recent-error search. Keep separate incidents identifiable through batching.

Reuse history and cached results before querying. A cached result remains useful
for its recorded window; report its freshness and obtain later evidence when the
question concerns current status. Record unqueried windows/IDs and why they
matter, rather than silently implying complete coverage.

Identical initial queries reuse saved evidence by default. If delayed ingestion
or freshness requires rereading the same filter/window, set `refresh:true` on a
new initial query. Never combine refresh with cursor continuation; continue that
read with its cursor alone. Reused evidence retains its original `retrievedAt`.

## 2. Discover resources, then correlate outcomes

Use `livex_gcp_logs_read` for production logs. The workspace defines the fixed
project/caller policy. This skill grants no direct cloud CLI, credentials,
additional repositories, metrics, or remediation access.

| Evidence available | Next read |
| --- | --- |
| Observed IDs and time, missing resource selectors | `mode: "discover"`, ID fields, `start`, `end`; no resource type/labels |
| Returned resource selectors | `mode: "context"`, observed `resourceType`/`resourceLabels`, window, and necessary ID constraints |
| Specific error-level question after context | `mode: "errors"` in the verified scope |
| Continuation returned, including an empty page | Pass `{ "cursor": "<returned nextCursor>" }` alone |

Discovery requires one or more of `conversationId`, `jobId`, `roomId`, `traceId`,
`insertId`, or `insertIds`. It searches Cloud Run (`cloud_run_revision`) and GKE
(`k8s_container`) at all severities. Supplied identifiers are OR alternatives:
one service may record a conversation while another records a job. A returned
row need not match every supplied ID. Preserve which operation each row supports.

Build a timeline from the returned resource selectors, timestamps, source IDs,
and correlation fields. Follow relevant WARNING/DEBUG entries as well as errors.
Use current discovered selectors for context reads; never hardcode service, pod,
namespace, or revision values for future incidents.

In `context`/`errors`, supplied ID fields use AND, with alternatives within a
field. Pass only IDs needed for that read. Remove insert-ID constraints when
expanding from the seed event to initialization, connections, readiness, retries,
and terminal outcomes. Broaden selectors only where observed evidence justifies
it, such as a service spanning two revisions.

## 3. Finish each relevant read without overstating coverage

Each page returns at most 50 entries (default 20); each query window is at most
one hour. Follow `nextCursor` with `{ "cursor": "<returned nextCursor>" }` alone,
even after an empty page. Do not alter filters or round/increment timestamps to
paginate. Inspect `windowExhausted`, filter-specific coverage, and
`truncationReasons`. An exhausted window for one filter is not coverage of other
IDs, services, hours, or the case. Keep relevant continuations and remaining work
in the native coverage plan.

A page cap, partial output, timeout, or projected entry can hide evidence.
Distinguish complete returned-filter coverage from complete incident coverage.
Deduplicate overlaps by source identity, and state the population counted;
sampled logs are not total failures or customer counts. A missing projected field
does not establish missing instrumentation. Silence or an empty result alone
proves neither recovery nor missing IAM. Preserve exact source links and
`retrievedAt`; do not repeat identical completed reads without a new reason.

There is no fixed query-count stop rule. Continue allowed queries while they
resolve material coverage gaps or test an explanation. Do not ask approval for
the ordinary allowed next query. If a runtime/resource failure cannot be resolved
within available tools/budget, give partial findings and its exact effect on
coverage. Never treat a failure or exhausted page as automatic case completion.

## 4. Test the explanation with logs and approved code

Separate the observed failure from its cause. A signaling transport timeout
proves that attempt timed out; it does not alone prove provider outage, network
cause, or the final conversation outcome. Compare the order of initialization,
connection, readiness/status, and success/failure events across components.

Use `livex_repository_read` to list approved services and read/search their
pinned commits when source code can explain the observed path. It permits no
execution or mutation. Cite file/path and inspected commit. Treat that code as
mechanism evidence; deployment match remains unknown until independently
verified. A revision label alone is not a deployment timestamp or commit mapping.

For a suspected regression, compare equivalent windows and exposure. Verify
metrics, deploy, and independent trace access separately before claiming those
checks ran. Continue accessible evidence when a capability is missing; never
invent a code path, denominator, or deployed revision.

## 5. Decide whether to finish

Native Codex continues until evidence answers the request, true user input/access
is needed, the request is cancelled, or an actual runtime budget ends. No case
tool, checkpoint, or separate completion gate is required. Before the normal final
reply, verify material findings and retain important unknowns. Follow
`investigate-alerts` for the short response and evidence record.

Ask only for information that cannot be recovered through the allowed reads.
Never ask for resource labels before discovery when IDs and time are available.
If neither IDs nor selectors are recoverable, request one observed correlation/
insert ID or log link, and event time only if a usable window is missing too.
For denied or unavailable access, state the exact attempted action/target,
failure, blocked conclusion, and smallest remedy. Do not switch tools, accounts,
credentials, or generic shell commands to bypass the boundary.
