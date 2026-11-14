# Playbook: Low Conversation Volume Report

Provenance tags as in [gke-application-errors.md](gke-application-errors.md).

## Match

Not a Cloud Monitoring alert. A report bot posts one message per agent to
#alert-prd (C079BU33H0W) and mirrors it to #on-call-prd: `*Low Conversation
Volume Report:* *Agent* \`<name>\` (<pub-id>): 0 MessageSent events; 0
conversation records created in 5 min (both below threshold 1)`.
Seen 16 posts on 2026-11-12 16:30-16:40 PST and 2026-11-13 18:30-18:45 PST,
in rounds of several agents at once, for Microsoft Ignite demo agents (for
example https://livexai.slack.com/archives/C079BU33H0W/p1794623718736869). No
thread replies and no human conclusion were found: every row below is
(unmined) or (unverified).

## Workload

No GKE workload is named. To look for the agent's traffic use chat-engine:
`resourceType: "k8s_container"`, labels `project_id: livex-copilot-prd`,
`location: us-central1`, `cluster_name: copilot-prd-cluster`,
`namespace_name: chat-engine`, `container_name: chat-engine`, and the agent's
`pub-...` id as a literal phrase.

## First checks (in order; stop when the timeline explains the symptom)

1. **Group the round.** From the thread and neighbours in the last 30 min,
   list the agents in the same round and their customers. One customer's demo
   agents versus agents across customers decides step 4.
2. **Is silence expected?** Read the agent name and thread context: event
   demos, kiosks and off-hours agents go quiet. If a human said the event ended or the
   device is off, that is the answer.
3. **Traffic history.** `livex_gcp_logs_read {mode:"count", resourceType:"k8s_container", resourceLabels:<chat-engine>, agentId:"<pub-id>", start: now - 6h, end: now}`
   (no phrases; totals and buckets come back under the key `"*"`) per agent (up to N=3 agents, proposed). Buckets show when requests stopped
   and whether the agent had traffic earlier.
4. **Platform check.** `mode:"errors"` on the chat-engine labels for the last
   30 min: are errors elevated for many agents? Elevated platform errors plus
   several customers' agents silent at once is a platform signal.
5. **Impact sample.** For one agent with earlier traffic, `mode:"context"`
   with its last conversation id to see how the last conversation ended.

## Correlation table

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| Zero requests for the agent in all 6 h buckets | agent is a demo or event agent | no traffic expected (unverified) | Low; say expected is unconfirmed by a human. *(unmined)* |
| Traffic earlier, stops at one minute | no errors for the agent | the visitor flow stopped, device off or event ended | Medium only if the agent normally runs continuously. *(unverified)* |
| Traffic stops for agents of several customers at once | chat-engine or gateway errors up | platform or ingress problem | One investigation of the platform workloads. *(unverified)* |
| Agent has errors in the window but no requests | `Could not find agent with id` or config validation errors | agent config or publish broken | See error-digest-categories.md. *(unverified)* |

## Known causes

Call `investigation_lookup` with `<agent name> | conversation volume | no traffic`. A hit is a lead; ignore its resolved state.

## Severity

All proposed; priority is `provisional: true`.

- **High**: 5 or more agents across 2 or more customers are silent in the same
  round and platform errors are elevated (proposed).
- **Medium**: one agent that had traffic in the earlier buckets goes silent
  for at least 30 minutes while its error count is non-zero (proposed).
- **Low**: demo, event or off-hours agent, or no earlier traffic.
- **Unknown**: the traffic history could not be read.

## Owner

Unassigned (TBD). No responder in the threads read.

## Expected window / when the classification is wrong

Demo agents recur for the duration of an event. If silence persists after a
human says the event is running, or the agent shows steady traffic before and
no errors, the "expected" classification is wrong: escalate as Medium and ask
for the device or kiosk state.
