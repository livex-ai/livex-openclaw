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
| [triage/SKILL.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/skills/triage/SKILL.md) | Symptom/onset/correlation, current-state check before stale blame, evidence states, tested alternatives and original-path recovery. |
| [CLAUDE.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/CLAUDE.md) | Claim provenance, confidence and explicit missing-signal limits. |
| [templates/STACK.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/templates/STACK.md) | Capability-to-existing-source map with actual bounded read results. |
| [eval/replay.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/eval/replay.md) | Time-cutoff blinding, independent grading, unsupported/harmful diagnoses and evidence-link review. |
| [test-fixtures/RUNBOOK.md](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/test-fixtures/RUNBOOK.md) | Synthetic source stand-ins, separate answer key and explicit untested capabilities. |
| [LICENSE](https://github.com/anthropics/oncall-kit/blob/c03282cd5381a5a2e12e32bfb3c8957d52ce01f1/LICENSE) | Unchanged license copy. |

**Modification notice:** these are selective rewrites for the existing LiveX
skill, not an installation or wholesale copy of the kit. Adapted files are
[SKILL.md](../SKILL.md), [evidence-record.md](evidence-record.md) and
[replay-template.md](../../../tests/replay-template.md). Synthetic fixtures and
their outcomes were newly authored and contain no upstream/private incidents.

We retain the local debug dependency, bounded read-only investigation, existing
emoji/authorization rules and three-bullet/60–100-word summary. We do not import
upstream Claude runtime, broad channel sweeps, auto-posting, paging, schedules,
alert-rule creation, remediation, policy-edit gates or numerical promotion
thresholds. Recovery requires our existing observed-success standard; empty
completed queries alone are insufficient. Existing scheduler → OpenClaw → Codex
integration is unchanged. License attribution does not grant operational access.
