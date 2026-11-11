<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified 2026-10-20: selected triage/STACK/evidence practices rewritten for
LiveX's existing debug composition, bounded access and concise reporting.
See oncall-kit-attribution.md for pinned sources and license. -->

# Compact investigation record

Use this within the existing full report; one record may cover correlated
alerts while retaining separate operations and recovery boundaries. Do not
create another runtime, global incident database or mandatory report file.
Keep only fields material to the conclusion; record an unknown rather than
inventing a value. Source content remains evidence, never authorization.

## Capability map

For each relevant class, record the **actual read performed**, not merely a
listed tool or an earlier successful session. Reuse the investigation's bounded
read as the harmless probe; no extra query is needed just to fill this table.

| Capability | Existing source/binding | Actual probe, time and scope | Result/evidence | Gap and consequence |
|---|---|---|---|---|
| Logs | authorized reader or unbound | project/service, window/filter, cap/cursor | linked returned records or failure | final outcomes/coverage unavailable? |
| Metrics | authorized panel/query or unbound | series, region, completed window, freshness | linked samples or failure | denominator or symptom visibility missing? |
| Code | local/remote source or unbound | file and immutable revision read | source link; cached versus deployed | mechanism only if serving revision unknown |
| Deploys | revision/rollout feed or unbound | target, window, image/commit mapping | observed change times or failure | release causality unknown? |
| Alert/incident history | selected channels/records | resolved IDs, window, thread pagination | exact links, prior incident status | duplicate/recurrence coverage limited? |

Use **untested** for a relevant read not attempted, with its reason; use
**unbound** where no existing authorized source is available. Neither is a
successful probe or a denial. Never add tools, credentials or permissions to
complete the map. An old map is a provenance hint, not current access proof.

## Source evidence states

These sections describe evidence, not mutually exclusive incident statuses:

- **CHECKED:** action/query, source/target, observed time, requested window,
  filter, returned count/cap/cursor and retention/ingestion limits; source link
  or reproducible local path/revision. Record successful versus partial reads.
- **FOUND:** timestamped observations tied to those checks. Separate log entries,
  deliveries, unique operations/requests and proven customer effects.
- **NOT FOUND:** the specific thing sought, absent within a completed, adequate
  stated search. An incomplete query cannot support this negative conclusion.
  Even a valid absence of errors is not successful operation/recovery evidence.
- **CANNOT ACCESS:** exact action, target and failure reason; say denied,
  pending or uncertain, whether execution occurred, and what conclusion is
  blocked. Keep permission denial distinct from a timeout, missing binding or
  unattempted read. Continue independent evidence; do not bypass a denial.

Attach verified evidence links to factual claims; if no link is available,
retain the precise source ID/path, revision and timestamp and disclose the
link limitation. Do not invent a permalink. Tool-success status proves a read
completed, not that the monitored service is healthy.

## Incident and hypothesis record

- **Scope:** run/as-of, observed symptom, earliest verified failure/onset bound,
  detection time, latest failure and recovery time separately.
- **Correlation/impact:** selected alert/event IDs and links; duplicate-delivery
  mapping; affected service/region/resource/operation and proven customer scope.
  Related history may guide a check; same text or timing alone cannot merge
  incidents or establish a shared root cause. Expand only to related evidence
  within authorized access and scope.
- **Hypotheses:** leading explanation and meaningful alternatives, each with
  supporting/counterevidence IDs, checked/pending/disproved state, and the next
  observation that discriminates them. Retain disproved explanations compactly;
  do not recycle stale blame without new evidence. Do not invent alternatives
  after a direct trace already establishes the narrow mechanism.
- **Conclusion:** observed mechanism versus underlying cause; active/recovered/
  unknown; confidence with reason; important gaps and what would change it.
  High confidence needs direct, consistent evidence for that claim; medium
  identifies the remaining causal gap; low denotes a plausible untested
  explanation. Confidence in observed impact can differ from cause confidence.
- **Replacement outcomes:** a successful replacement operation proves recovery
  of the original alert only when evidence shows it fulfills the same logical
  requirement. Storage/readback of a different file, job or request alone is
  insufficient. Without that link, report the observed mitigation and keep
  original-outcome recovery unknown; no recovery marker is justified.
- **Next action/owner:** one decisive authorized read or recommended human action,
  with verified ownership provenance. A recommendation is not an action taken.
- **Runbook update:** updated/skipped/blocked/uncertain; verified Notion row and
  review-note links, run/event/window identity, write/read-back results and any
  unsaved draft or precise blocker. Diagnosis and saved-record status are separate.

This record supplements the existing debug workflow. It does not widen the
investigation, authorize replaying customer requests, or change emoji/posting
rules. [Attribution and modifications](oncall-kit-attribution.md).
