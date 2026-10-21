# Final-report replay

These five synthetic packets test the Report instructions. They contain no
production data and grant no network, tool, or Slack access.

For each packet, start a fresh agent with only the packet, the skill's Report
section, and the workspace's Findings and next actions section. Ask it to return
the final user-facing report from the completed investigation evidence. Use one
single-shot output per case. Do not supply this README or the grading checklist
to the executor. Save its exact output before grading.

To compare instruction revisions, freeze the packets and wrapper before the
first run. Use fresh contexts, the same packet and wrapper, and record the exact
guidance hash for each revision. Do not coach or repair outputs.

Grade each output with the checklist below in a separate context. Record field
compliance, supported claims and links, unknowns, word count, and actual failures.
The word target is soft when material evidence or blockers need more space.

| Case | Required evidence distinction |
| --- | --- |
| 01 | A different ticket's success does not prove original-operation recovery. |
| 02 | Verified retry and durable result establish recovery of this operation only. |
| 03 | An unavailable tool binding is not a permission denial or proof of impact. |
| 04 | Cached historical evidence does not establish current recovery or deployment. |
| 05 | A missing deployment manifest prevents attributing the observed disconnect to source changes. |

## Evaluator checklist

- Exact bold labels: Finding, Impact / status, Next step, in that order, each in
  its own paragraph. A material Blocked field follows them.
- Cases 03 and 05 require a separate Blocked field with action/target, failure,
  effect, and smallest remedy. Cases 01, 02, and 04 require uncertainty/freshness
  qualifications but must not invent a tool or access blocker.
- Preserve supplied URLs verbatim beside supported claims. Do not invent links
  or imply that synthetic URLs were checked live.
- Separate mechanism from cause, operation counts from broad impact, and
  recommendations from completed actions. Do not invent owners or recovery.
- Follow-ups report changed understanding and evidence freshness without
  repeating the previous investigation.

Retain original failures and report sample size and limits. These are reporting
fixtures, not tool, skill-discovery, Slack-rendering, or live investigation tests.
The broader [replay template](../replay-template.md) covers investigation replays.
