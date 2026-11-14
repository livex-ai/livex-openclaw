# oncall-kit attribution and adaptation

Selected documentation practices were adapted on **2026-10-20** from
[anthropics/oncall-kit](https://github.com/anthropics/oncall-kit), revision
[`c03282cd5381a5a2e12e32bfb3c8957d52ce01f1`](https://github.com/anthropics/oncall-kit/commit/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1),
committed **2026-08-06T18:38:51Z**. The current main reference was resolved and
all six files read at that pinned revision using the GitHub read connector.

**Copyright 2026 Anthropic PBC. SPDX-License-Identifier: Apache-2.0.**
The complete, unmodified upstream [Apache-2.0 license](LICENSE-oncall-kit.txt)
is included. Its Git blob SHA is `d645695673349e3947e8e5ae42332d0ac3164cd7`.
The complete upstream tree (107 entries, not truncated) contained no NOTICE file.

## Sources and modifications

| Pinned primary source | Selected adaptation |
|---|---|
| [triage/SKILL.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/skills/triage/SKILL.md) | Symptom/onset/correlation, current-state check before stale blame, evidence states, tested alternatives and original-path recovery. Added 2026-11-14: the triage procedure (classify against a table of playbooks, check known causes, correlate alerts that share a cause, run first checks, apply the correlation table, verify against the timeline) as the Workflow section of [SKILL.md](../SKILL.md), and its diagnosis format (what's happening, root cause with confidence, blast radius, proposed action, ruled out, would change my mind) as the fixed report shape. |
| [skills/triage/references/test-failures.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/skills/triage/references/test-failures.md) and [examples/run1-webshop/references-card-declines.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/examples/run1-webshop/references-card-declines.md) | Added 2026-11-14: the per-failure-class reference-file structure (match, first checks in order with a stop condition, correlation table with provenance per row, known causes, escalation/owner, expected window and when the classification is wrong) for the playbooks in this directory. Only the structure is adapted; the content is LiveX-specific and mined from LiveX Slack history and source. |
| [templates/lessons.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/templates/lessons.md) | Added 2026-11-14: only the idea of a known-causes check before theorising, mapped to the existing `investigation_lookup`; no lessons file is created. |
| [CLAUDE.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/CLAUDE.md) | Claim provenance, confidence and explicit missing-signal limits. |
| [templates/STACK.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/templates/STACK.md) | Capability-to-existing-source map with actual bounded read results. |
| [eval/replay.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/eval/replay.md) | Time-cutoff blinding, independent grading, unsupported/harmful diagnoses and evidence-link review. |
| [test-fixtures/RUNBOOK.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/test-fixtures/RUNBOOK.md) | Synthetic source stand-ins, separate answer key and explicit untested capabilities. |
| [LICENSE](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/LICENSE) | Unchanged license copy. |

The 2026-11-14 additions were read from a local copy of the kit; its
revision was not re-verified against the pinned commit above.

**Modification notice:** these are selective rewrites for the existing LiveX
skill, not an installation or wholesale copy of the kit. Adapted files are
[SKILL.md](../SKILL.md), [evidence-record.md](evidence-record.md), the
playbooks ([gke-application-errors.md](gke-application-errors.md),
[phone-call-notes.md](phone-call-notes.md),
[error-digest-categories.md](error-digest-categories.md),
[low-conversation-volume.md](low-conversation-volume.md),
[log-match-alerts.md](log-match-alerts.md)) and the
authoring workflow's `replay-template.md`. The template is outside this native
workspace. Synthetic fixtures and their outcomes were newly authored and
contain no upstream/private incidents.

We retain the local debug dependency, bounded read-only investigation, existing
emoji/authorization rules and labeled 60–100-word summary. We do not import
upstream Claude runtime, broad channel sweeps, auto-posting, paging, schedules,
alert-rule creation, remediation, policy-edit gates or numerical promotion
thresholds. Recovery requires our existing observed-success standard; empty
completed queries alone are insufficient. Existing scheduler → OpenClaw → Codex
integration is unchanged. License attribution does not grant operational access.

The native Debugger uses review dispositions in normal Slack replies, with
reaction read-back only and no external runbook writes.
