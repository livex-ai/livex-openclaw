# Error summaries and trends

Use this workflow for a bounded service-wide error overview, including “summarize
errors”, “what is happening?” on an aggregate alert, and an expanded search window.
Reuse the debug skill's authorized tools, hourly query plan and cursor-only paging.
This workflow grants no new access and does not replace a requested root-cause investigation.

## Collect the requested population

Freeze an as-of time and explicit start/end with timezone. Reuse the user's
verified workload selectors and error definition. For a service-wide overview,
do not keep the original alert's conversation/insert-ID restriction: that would
hide other categories. Retain workload scope; obtain observed selectors first
when missing. Do not broaden to another environment, service or project.
If the tool's error mode does not implement the supplied formatter/predicate,
use allowed all-level context reads and classify the returned entries using that
exact definition. Do not silently substitute a simpler filter or invent a tool
argument. Explain any projection that prevents exact classification.

Cover the entire requested window in disjoint windows of at most one hour.
Follow every nextCursor, including after empty pages. Reuse complete cached
windows with their retrievedAt; refresh only for a justified freshness gap.
State pages/windows still missing. Capped, truncated or unavailable coverage
means a partial summary with lower-bound counts, never an exact total.

Deduplicate identical log events by stable source identity. Group every materially
distinct error category; preserve customer, operation and recurrence distinctions
inside each group. Retries and propagation across layers remain separate log
entries but may describe one operation. Only count unique operations when IDs
and timing establish that relationship. Count valid conversation IDs separately;
exclude placeholders, expose entries without IDs, and never sum overlapping
category conversation counts into a global total. Do not equate a conversation
with a failed request or a customer. Identify test agents only from evidence.

## Present an overview before interpreting trends

Use ordinary thread text, not a Priority / Next action / Summary case card.
Return:

1. Exact window and timezone, workload/filter scope, completeness and freshness.
2. Total matching logs and observed severity distribution; distinct usable
   conversation/operation counts when supported, with missing-ID coverage.
3. Every material category, ordered by count or verified impact: category,
   log count, distinct affected scope if known, and a short explanation of the
   failure, retry/propagation pattern and known original-operation outcome.
   Use a table where supported; in Slack use compact category bullets with
   those same fields. Do not drop small but important categories or hide them
   under an unexplained “other”. If length requires grouping, enumerate what
   was grouped and disclose omissions or incomplete category counts.
4. Patterns and a few evidence-supported follow-ups. Priority is based on impact,
   not volume. Separate confirmed observations, likely causes and unknowns;
   no new incident priority or ownership is implied by ordering this list.
5. Verified query/evidence links, plus important coverage and outcome gaps.
   Never fabricate links or leak raw customer payloads.

An increase/pattern question adds comparable, equal-duration time buckets with
identical scope and filters, and category-level changes after the inventory.
A narrow single-error question stays narrow. Lead briefly with the answer, then
show the supporting inventory and trend. For “increase the window”, preserve
the prior service/filter and widen time coverage; recompute the complete
category inventory, not just previously discussed categories. If the intended
new duration is unavailable, state a reasonable bounded assumption or clarify.
Different endpoints or filters make totals non-comparable: do not infer a trend
from them. Counts cannot establish failure rates without a request denominator;
no errors or a decreasing last bucket proves recovery. Scope all trend claims to
the inspected window; do not extrapolate a long-term pattern from a short sample.

## Preserve workflow and memory boundaries

A summary is an overview, not a new synthetic case spanning unrelated failures.
Reuse relevant existing case evidence and its age. Save a supported observation
only through the existing authorized trend workflow, to an unambiguously matched
case and its own scope. A service-wide aggregate is not evidence of a specific
case's trend. Missing case match or comparable evidence means an ordinary reply
with the gap; do not create a case or overwrite unrelated case facts.
An explicit investigation or root-cause request retains debug/investigate-alerts
checks and separate findings; an explicit report or amendment retains its typed
report/edit workflow. An overview neither replaces requested investigation nor
authorizes production changes, new credentials, reactions or extra Slack posts.
