# Playbook: single-event log-match alerts

Provenance tags as in [gke-application-errors.md](gke-application-errors.md).

## Match

Cloud Monitoring log-match alerts that fire for one conversation, with
`agent_id` and `conversation_id` labels and a `Documentation` section:

- `Query Rewrite Error` (seen 3 in a 24 h sample, 2026-10-22/23; investigated
  often on 2026-11-12/13 for El Camino, Wyze and Sojitz conversations; bot
  findings only).
- `Error while generating answer - I am sorry, I have encountered an error. Please try again later.`
- `Error in generating ticket` (message `Error creating tickets in create_zendesk_ticket: Client error '422 ...'`; 3 in the 24 h sample).
- `Salesforce client init failed` (message `Error initializing Salesforce client: ... second argument (exceptions) must be a non-empty sequence`; 5 in the 24 h sample).

## Workload

`resourceType: "k8s_container"`, labels `project_id: livex-copilot-prd`,
`location: us-central1`, `cluster_name: copilot-prd-cluster`,
`namespace_name: chat-engine`, `container_name: chat-engine` (the alert also
names the pod). Use the alert's `conversation_id` as `conversationId`.

## First checks (in order; stop when the timeline explains the symptom)

1. `livex_gcp_logs_read {mode:"context", resourceType, resourceLabels, conversationId, start: alert - 5 min, end: alert + 10 min, limit:50}`. Read the failing turn through to the saved answer.
2. **Did this turn answer?** Look for a saved assistant message after the error that is not the generic error text. That decides user impact.
3. **Client effect sample.** Run the Client effect check below.
4. **Test versus live.** Agent name, `test_run`/`test_suite` markers, demo agents.

## Correlation table

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| `Query Rewrite Error` | a later answer saved in the same turn | the rewrite failed and the turn fell back | Not affected; name the model/provider seen in the context read. *(unverified: Wyze and El Camino Los Gatos rewrite alerts were investigated on 2026-11-12 on request, but their findings were not read)* |
| `Query Rewrite Error` | many agents, `You have reached your specified API usage limits` in the window | provider cap | See error-digest-categories.md. *(unverified)* |
| `Error while generating answer` | generic error answer saved | the user saw the error; race timeout or provider failure | See chat-engine rows in gke-application-errors.md. *(seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794586439158319 - GPT-4.1 invalid JSON, generic answer saved; bot finding)* |
| `Error creating tickets in create_zendesk_ticket` 422/409 | a retry later returned 201 | transient Zendesk conflict | Not affected: recovered for that ticket (seen 1×, bot finding: https://livexai.slack.com/archives/C079BU33H0W/p1794459133056959). |
| `Error creating tickets` 4xx | Wyze, suspended requester | known case | Human-decided as known: `pattern:wyze-zendesk-suspended-requester` below. |
| `Salesforce client init failed` | one customer's agent repeats | credential or token problem on that customer's integration | Name the agent; check whether answers continue without Salesforce. *(unverified)* |

## Known causes

Call `investigation_lookup` with `chat-engine | <operation> | <error class>` and with the alert title; a hit is a lead, not a conclusion.

## Client effect check

Sample N=5 conversations by default (proposed): the alert's own conversation
(step 1) plus up to 4 others. Find them with `mode:"count"` and the alert's key
phrase over the last 6 h (its `samples` carry ids), or
`mode:"errors", textContains:<phrase>, limit:50` over one hour; then one
`context` read per id by `conversationId` over that turn plus a few minutes.
A conversation is **affected** when the user saw the generic error text or got
no answer for that turn; for `Error in generating ticket`, when no retry
returned 201 (the ticket was not created); for `Salesforce client init failed`,
when the turn did not answer without Salesforce. A turn that fell back and
answered is not affected.

## Sustained check

`sustained` is true when a `count` of the alert's key phrase over the last
6 h shows it in at least 2 hourly buckets (proposed). Otherwise false.

## Known patterns

`knownRef` is the id cell, copied verbatim. Only people edit this table;
suggest a new row in the thread.

| id | pattern | state (fixed or harmless) | since | source |
| --- | --- | --- | --- | --- |
| `pattern:wyze-zendesk-suspended-requester` | `Error creating tickets in create_zendesk_ticket` 4xx for the Wyze agent, "suspended requester" | harmless | 2026-11-06 | https://livexai.slack.com/archives/C09N85B5664/p1793993173960419 (Tanmesh: known, does not count) |

## Alert severity

Use the severity the alert text states. When it states none, use
`alertSeverity: "error"` (all four alerts match error log lines). `alertClass`
is `log-match-alerts`; `service` is `chat-engine`.

## Owner

Unassigned (TBD). No human accepted these alerts in the threads read.

## Expected window / when the classification is wrong

A transient provider or Zendesk error clears within one retry. If the same
phrase recurs across hours with failed answers, it is not a one-off: treat as
the repeated class in gke-application-errors.md.
