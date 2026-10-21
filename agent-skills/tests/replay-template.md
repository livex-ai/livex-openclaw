<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified 2026-10-20: replay/RUNBOOK practices adapted to local synthetic
fixtures, separate grading and no live connections or operational thresholds.
Source details: ../skills/investigate-alerts/references/oncall-kit-attribution.md. -->

# Offline incident replay template

Use after a material investigation-skill change. This is an offline evaluation,
not an incident scan, installation, shadow deployment or scheduled routine.
Use synthetic sanitized records; do not copy private logs or customer data to
external services. Do not load upstream runtime or execute its code.

## Prepare two separate packets

**Diagnosis packet (visible to the executing agent):**

| Field        | Record                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Case/version | fixture ID, skill revision/hash and evaluator date                                                              |
| Request      | original symptom, authorized scope, as-of/detection cutoff, marker opt-out                                      |
| Evidence     | only records available at that cutoff, with event time AND available-at time                                    |
| Capabilities | simulated authorized reads and actual fixture responses, including denied, timed-out, capped or unbound sources |
| Source index | stable local paths/anchors for each alert, trace, metric, revision and history record                           |

Freeze or content-hash the diagnosis packet before execution. Cite that exact
packet, not a working copy that may later gain outcome evidence. Preserve the
original output and document any path-only normalization in a portable copy;
normalizing a citation does not repair the original run's provenance failure.

**Outcome packet (withheld from the executing context):**
later evidence, verified outcome/root cause if known, resolution time, and
grading criteria. Keep expected answers, outcome contents and postmortems out
of the diagnosis context. For an initial-alert replay, exclude later replies
and recovery. If testing a follow-up, freeze the first diagnosis before releasing
a separately timestamped evidence packet. Never let today's live data answer
a historical question.

## Execute

Use a fresh agent with only the skill, relevant references, local debug
dependency and diagnosis packet. Simulate external reads, failures and emoji;
perform no network, Slack, production or credential actions. Save the actual
short summary and full evidence record before exposing any outcomes. Evidence
not present in the packet is unavailable, not an invitation to query production.
Do not coach the agent toward the intended cause or repair its output.

Cover normal failure, missing access, duplicate deliveries/distinct recurrences,
verified versus proxy recovery, and suspected regression/stale deployment blame.
Use held-out variants when revising guidance learned from a prior case. Record
which classes and access failures were not exercised. Do not infer runtime
readiness from fixture success.

## Grade independently

A different fresh context receives the input packet, frozen diagnosis and
outcome packet. Grade the decision **using what was knowable at the cutoff**,
then record agreement with later outcome separately. A well-supported unknown
can be correct; a lucky unsupported diagnosis remains unsupported.

| Case    | Decision quality                                         | Later outcome agreement     | Evidence/link checks                    | Risk/omission                       | Narrow correction               |
| ------- | -------------------------------------------------------- | --------------------------- | --------------------------------------- | ----------------------------------- | ------------------------------- |
| case ID | supported/useful, partial, unsupported/wrong, or harmful | matches / differs / unknown | valid local source and claim supported? | quote actual output and consequence | proposed wording change or none |

Check deduplication, onset/blast radius, observed versus hypothesized cause,
current symptom versus old blame, capability gaps, coverage-qualified absence,
original-operation recovery and owner evidence. Check that every citation
resolves to the intended supplied record and supports its claim. Offline link
checks cannot establish that a real external permalink remains accessible.
Evaluate short-summary clarity separately from diagnosis correctness.

Flag harmful advice by its concrete consequence: worsening the incident,
bypassing access controls, unsupported broad remediation or falsely clearing
material unresolved impact. Record unsupported claims even when not harmful.
Any discovered material failure requires a targeted correction and another
independent run of affected cases before claiming that case passes. Keep failed
outputs and the original grade; do not silently rewrite history.

## Results to retain

Record fixture/skill versions, cutoff, executor/grader identities or run IDs,
actual outputs, per-case grades, evidence-link checks, known failures and exact
checks run. State sample size, whether variants were held out, and whether a
human reviewed the grades. Do not invent pass percentages, paging thresholds or
promotion gates. A single synthetic run demonstrates only those cases; it
does not prove production diagnosis quality, real access or safe automation.

Prepare separate synthetic input and outcome packets for each replay. This
package supplies the template, not a completed replay or production fixture.
[Attribution](../skills/investigate-alerts/references/oncall-kit-attribution.md).
