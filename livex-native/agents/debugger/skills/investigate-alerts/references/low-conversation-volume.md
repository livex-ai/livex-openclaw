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
2. **Is silence expected?** Read the thread: if a person said the event ended
   or the device is off, the agent is not affected. Event and kiosk agents are
   live; the agent name alone does not make silence expected.
3. **Traffic history.** Per agent (up to the 5 agents of the Client effect
   check), two counts with `agentId` and no phrases (results under the key `"*"`):
   - B1 and B2 are the two full hours before the hour that contains the alert
     time (alert at 14:37 UTC: B1 = 12:00-13:00, B2 = 13:00-14:00). One count:
     `livex_gcp_logs_read {mode:"count", resourceType:"k8s_container", resourceLabels:<chat-engine>, agentId:"<pub-id>", start: <B1 start>, end: <B2 end>}`;
     its two hourly buckets are B1 and B2.
   - The alert window is the 5 minutes before the alert post. A second count:
     the same call with `start: <alert post> - 5 min, end: <alert post>`.
   If either count returns `complete:false`, say the history is a lower bound
   and set `clientEffectVerified` false (an incomplete count also keeps "no
   client effect" from counting for this thread).
4. **Platform check.** `mode:"errors"` on the chat-engine labels for the last
   30 min: are errors elevated for many agents? Elevated platform errors plus
   several customers' agents silent at once is a platform signal.
5. **Client effect sample.** Run the Client effect check below.

## Correlation table

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| No requests in B1 or B2 | | no recent traffic | Not affected; say "no recent traffic" in the summary. *(unmined)* |
| Requests in exactly one of B1 or B2 | | sparse traffic | Not affected; say "sparse traffic" in the summary. *(unmined)* |
| Requests in both B1 and B2, none in the alert window | no person has said the agent is off | the visitor flow stopped, device off or a fault | Affected (Client effect check). *(unverified)* |
| A silent agent is a test or demo agent | | non-customer traffic | Same rule as any agent; it stays in the affected set. Report `traffic: "test"` only when every affected item is on a test or demo agent (wording in the Client effect check). Event and kiosk agents are live. *(unmined)* |
| Traffic stops for agents of several customers at once | chat-engine or gateway errors up | platform or ingress problem | One investigation of the platform workloads. *(unverified)* |
| Agent has errors in the window but no requests | `Could not find agent with id` or config validation errors | agent config or publish broken | See error-digest-categories.md. *(unverified)* |

## Known causes

Call `investigation_lookup` with `<agent name> | conversation volume | no traffic`. A hit is a lead; ignore its resolved state.

## Client effect check

Sample the agents of the round, N=5 by default (proposed); each agent is an
item, and its outcome is the two counts of step 3. For each agent, in order:

1. Requests in both B1 and B2, none in the alert window, and no person in the
   thread has said the agent is off: **affected**.
2. Requests in exactly one of B1 or B2: "sparse traffic", not affected; say so
   in the summary.
3. No requests in B1 or B2: "no recent traffic", not affected; say so in the
   summary.
4. Otherwise (requests in the alert window, or a person said it is off): not
   affected.

Test and demo agents follow the same steps; they are not excluded from the
affected set. Never count an agent whose counts you did not read; if either
count returns `complete:false`, say the history is a lower bound and set
`clientEffectVerified` false. `traffic: "test"` only when every affected item
is on a test or demo agent, shown by an explicit marker (`test_run`,
`test_suite`, `EXPERIMENT NOT PRODUCTION`) or the whole word `test` or `demo`
in the agent name; event and kiosk agents are live. `scope` counts the
customers of the affected agents.

## Sustained check

`sustained` is true when the same agent was in an earlier report round within
the last 2 hours (proposed). Otherwise false.

## Known patterns

`knownRef` is the id cell, copied verbatim; `known` is the row's state. Only
people edit this table;
suggest a new row in the thread. No row yet: no human conclusion was found in
the threads read.

| id | pattern | state (fixed, harmless or ongoing) | since | source |
| --- | --- | --- | --- | --- |

## Alert severity

The report carries none: use `alertSeverity: "warning"` (proposed).
`alertClass` is `low-conversation-volume`; `service` is `none` (no single
workload).

## Owner

Unassigned (TBD). No responder in the threads read.

## Expected window / when the classification is wrong

Event agents recur for the duration of an event. If silence persists after a
human says the event is running, ask for the device or kiosk state; the Client
effect check still decides whether the agent is affected.
