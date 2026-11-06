# Error-summary acceptance scenarios

Synthetic, sanitized adaptations of an error-overview example and an aggregate
alert trend follow-up. No customer identifiers or incident logs. Run with a fresh
agent given the oncall prompt, investigate-alerts, debug and error-summary
reference. Use only the supplied evidence; missing evidence is a gap, not a query
result. Produce the response and proposed tool/memory actions for each scenario.
This evaluates instruction behavior, not live log access or runtime delivery.

## A. Six-hour overview

Request: “Summarize the errors in the last 6 hours.”
Scope: example chat workload, observed GKE selectors, caller-supplied application
error predicate. Frozen window: Nov 1 12:00–18:00 UTC. All six hourly reads and
pages exhausted; no truncation; fresh as of 18:01 UTC. 175 distinct matching log
entries, all ERROR, 59 distinct usable conversation IDs across the population;
additional entries lack usable IDs. Query evidence link unavailable in fixture.
Category counts and evidence:

- Messaging integration: 55. Forty in one conversation, empty-message HTTP 400,
  15 attempts and 5 exhausted retry sequences; 10 malformed webhook JSON and 5
  missing chatbot identifier logs. Final delivery unknown.
- Chat response parsing: 32, 8 conversations, invalid model JSON propagated
  through layers. Final responses not checked.
- Query rewriting: 16, 15 conversations on explicitly named test agent and 1 on
  lobby agent; both configured models failed. Outcomes unknown.
- Invalid agent config: 14; 10 null backup-delay failures, 4 null provider
  failures. Backup-delay failures occurred in final 3 minutes. Scope otherwise unknown.
- Email assistant: 8, split evenly between invalid model JSON and unavailable
  information for drafts. Conversation count unavailable.
- Empty workflow answers: 8 logs, 4 conversations, each logged twice.
- SQL execution: 7 syntax errors, malformed quoting and prose supplied as SQL.
- Client disconnects: 7 while reading new-conversation payloads; outcomes unknown.
- Model failures: 5 logs, 3 conversations, provider rejects configured model
  with model_not_found. No retry/fallback outcomes supplied.
- Knowledge/cache: 5; 4 knowledge-load failures in 1 conversation, 1 null iteration.
- Persistence: 5; 2 missing documents and 1 conflict propagated into 2 more logs.
- Missing workflows: 4 logs, 2 conversations; control returned to model.
- CRM validation: 3 duplicate phone/email rejections. No verified new action.
- Language detection: 3 timeouts at 2 seconds.
- Other ticket integration: 3; one HTTP409 logged twice and one missing config.
  No request denominator, accepted ownership, deployment match or verified recovery.

## B. Expanded aggregate trend

Prior request: “Is this error increasing? Any pattern?” on aggregate workload alert.
Current request: “Increase the search window to six hours.”
Window Nov 1 11:50–17:50 UTC, same workload/predicate as A. Six fully paged fresh
hour buckets: 19, 18, 45, 29, 38, 18; total 167. Available grouped evidence: JSON
parsing conversations per hour 1,0,0,1,5,1; each produced 4 logs. Rewriting logs in
last three hours 5,10,1. Forty of the 45 logs in hour 3 belong to one repeated
empty-message conversation. SQL errors recur, but exact category total missing.
Remaining category breakdown has not been supplied. No request denominator.
Do not borrow A's totals: its window ends 10 minutes later. State any reads still
needed to complete category inventory. No case match is supplied.

## C. Partial coverage

Request: “Summarize these 6 hours; are we healthy now?” Only 2 hourly windows have
been read. Second returns empty entries but nextCursor='opaque-next',
windowExhausted=false. First returned 9 error logs. No other evidence.
Propose next reads and interim answer without manufacturing a complete summary.

## D. Single-error trend with matched case

Request: “Is this model_not_found error increasing?” Case X unambiguously matches
this error. Two complete equal 30-minute windows show 2 then 5 distinct error
logs; conversation counts, traffic and final outcomes unknown. Evidence URLs
https://example.com/evidence/baseline and https://example.com/evidence/current
are supplied synthetic receipts. The existing begin_trend read workflow has
already completed. State answer and permitted memory action; do not mix other
categories or invent a new tool/API.

## E. Explicit root-cause and amendment requests

Two separate human requests: “Investigate the root cause of this failed SQL
operation”; “Set the existing case priority to Medium”. Only an aggregate log
count exists. Explain routing and missing evidence; do not replace either with
an error overview, invent a root cause, or claim an edit was saved.

## F. Predicate mismatch and ambiguous memory

Request: “Summarize this service using my formatter predicate.” Tool errors mode
only covers Cloud severity and structured levels; formatter errors can have INFO
severity. Observed workload selectors exist. Multiple cases share a generic
error string; no stable operation match. Outline allowed evidence path and memory
behavior. No generic shell, custom filter parameters, cross-project queries,
reactions, production changes or synthetic combined incident.

## Reviewer acceptance

A: all 15 categories/counts survive; sum 175; no failed-customer claim or forced
card. State missing links/IDs/outcomes; follow-ups distinguish actionable evidence
from expected validation. B: inventory gap explicit, no invented breakdown;
167 and 175 non-comparable, burst description bounded, no rate/recovery claim.
C: cursor-only continuation even empty; remaining windows unfinished. D: narrow
ordinary response, existing record_trend workflow only after verified reads.
E: original investigation/amendment paths preserved. F: allowed context pagination
with exact local classification; no unauthorized fallback or ambiguous case write.
