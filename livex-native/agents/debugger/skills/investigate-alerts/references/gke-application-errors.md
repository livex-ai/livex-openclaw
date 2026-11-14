# Playbook: GKE application-error alerts

Adapted from the oncall-kit triage reference structure (see
[oncall-kit-attribution.md](oncall-kit-attribution.md)). Provenance tags:
`(seen N×: <thread links>)` = Slack threads read; `(code: <repo>@origin/main
<path>)` = source read; `(unverified)` = hypothesis. Slack threads where the
only replies are earlier debugger cards are bot findings, not human decisions;
the tag says so.

## Match

Title shape: `GKE <service>: more than <N> application errors in 10 minutes`.
Thresholds seen in alert text: api-gateway 10; chat-engine, chat-engine-avatar,
conversation-avatar, embedding-server 5. Body: "Counts include recoverable
errors and client cancellations; they do not measure failed requests."
Frequency, one 24 h sample (2026-10-22 to 10-23, 100 messages): api-gateway 26,
chat-engine 23, embedding-server 4, chat-engine-avatar 1.

## Workload

Always `resourceType: "k8s_container"`, plus these `resourceLabels` (copy from
the alert text if it differs; the alert text wins):

| Service | namespace_name | container_name |
| --- | --- | --- |
| api-gateway | api-gateway | api-gateway |
| chat-engine | chat-engine | chat-engine |
| chat-engine-avatar | chat-engine-avatar | chat-engine |
| conversation-avatar | conversation-avatar | conversation-avatar |
| embedding-server | embedding-server | embedding-server |

Common to all: `project_id: livex-copilot-prd`, `location: us-central1`,
`cluster_name: copilot-prd-cluster`.

## First checks (in order; stop when the timeline explains the symptom)

Window W = alert notification time minus 10 min to plus 2 min (UTC). The
Monitoring value cannot be read; the alert's own number is only the threshold
context.

1. **Top messages.** `livex_gcp_logs_read {mode:"errors", resourceType, resourceLabels, start, end}` over W; follow
   `nextCursor`. If `truncationReasons` includes `row-limit` and no `nextCursor`
   is returned, split the window or add `textContains`. Group entries by message shape (strip ids). Note the top 3
   shapes and 2-5 literal phrases that identify them.
2. **Size and onset.** `livex_gcp_logs_read {mode:"count", resourceType, resourceLabels, phrases:[<top phrases>], start: W.start - 5h, end: W.end}` (6 h
   maximum). Read `buckets` for onset and recurrence. If `complete:false`, say
   the totals are lower bounds. Stop here if one phrase explains the alert
   and it is a known harmless shape in the service section below.
3. **Impact sample (N=5 conversations or requests, proposed).** Take up to 5
   distinct conversation, session or request ids from step 1, spread across
   the window. For each: `livex_gcp_logs_read {mode:"context", ... , conversationId | traceId}` and check whether the user-facing operation
   still succeeded (service sections say what success looks like). Record
   `n_failed / n_checked`. Skip ids marked `test_run`, `test_suite` or demo
   agents from the live count and say so.
4. **Recurrence and neighbours.** Other alerts in the same 30 min from other
   workloads are separate until a shared trace id or a shared dependency is
   shown. Do not sum counts across workloads.
5. **Latest window.** Re-run step 2's count over the most recent complete 10
   min before answering. Errors in the alert window and none now is "quiet",
   not "recovered" (see Deeper investigation rule 3 in SKILL.md).

## api-gateway (Go, Gin)

Success = the HTTP request in the context read ends 2xx/3xx. A gateway entry
does not usually carry a conversation id; use the request path and trace id.

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| `panic recovered` with `nil pointer dereference` and a stack naming a controller file | HTTP 500 on that route in the same request | a handler bug on one route; Gin recovered the process, the request still failed | Name route and agent id, count 500s on that route, sample N requests; "panic recovered" is not request success. Priority from the Severity section. *(seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794586439158319 - bot finding, no human reply; the panic dump alone produced 43 lines, so counts overstate requests)* |
| Hundreds of entries in one 10 min bucket, app-error filter returns none in the same window | plain-text fragments (stack lines) share timestamps | one event printed as many lines; the alert count and the application-error read do not reconcile | Report the count discrepancy; use the request outcomes for severity, not the entry count. *(seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794459133056959 - 127 entries, bot finding, owner never accepted)* |
| 4xx on one route from many ids | a client (storefront, widget) sends a malformed id | caller bug, not a gateway fault | Route to the caller's owner; no gateway change. *(unverified for gateway; the same shape on chat-engine is in the chat-engine section)* |
| Upstream 5xx or timeout lines naming chat-engine, embedding-server or another service | that service also alerted in the window | dependency failure surfacing at the gateway | Investigate the dependency's workload first; one investigation. *(unverified)* |

## chat-engine

Success = a saved assistant answer that is not the generic error text, in the
same conversation after the failing entry. The generic text is "Sorry,
something went wrong. Please try again later." (seen in
https://livexai.slack.com/archives/C079BU33H0W/p1794586439158319). Many
entries are one turn logged at two layers; count conversations, not entries.

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| `Timeout during LLM language detection for text` | the same turn later has a saved answer | a 2 s language-detection timeout; the code returns "unknown" language and continues | Treat as noise unless the count is a large share of traffic; check the model race below. *(code: chat-engine@origin/main app/utilities/language_detector.py:526, default timeout 2 s at :441; seen 2×: https://livexai.slack.com/archives/C079BU33H0W/p1794459133056959 (Wyze answered after), https://livexai.slack.com/archives/C09N85B5664/p1794240015992969)* |
| `No model-race winner after 10.0s (10.0s budget)` | generic error answer saved for the conversation | the race between models hit its 10 s budget and the user got the error text | User-visible failure. Count affected conversations, check provider/LLM health (rows below), then the agent's configured models. *(code: chat-engine@origin/main app/agent/parallel_tool_agent.py:907, DEFAULT_MAX_TIMEOUT=10.0 at app/schemas/agent_config/tool_agent_config.py:35; seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1794240015992969 - 150 traces, the sampled one was `test_run`)* |
| `Request timed out` / `APITimeoutError` in a burst across Wyze or Ego agents | the burst is hours long | the self-hosted Qwen LLM rejecting or stalling, not a chat-engine bug | Check #on-call-prd for a Qwen notice; confirm which agents use it. *(seen 1×: https://livexai.slack.com/archives/C0BM1L6D755/p1794510349507229 - Dagang Wei: ~8 h outage 2026-11-12 02:42-10:40 PST, fix and watchdog rolled out in https://livexai.slack.com/archives/C0BM1L6D755/p1794520196642609, tracked LX-12525; whether a given later burst matches is unverified)* |
| `You have reached your specified API usage limits` | same provider, several agents or customers | provider spend cap, an account-level limit | Not a code fault. Check whether another model answered. Track under LX-12524 (tracking filed by Tanmesh; no accepted owner). *(seen 2×: digest threads of 2026-11-12, e.g. https://livexai.slack.com/archives/C09N85B5664/p1794474621136859)* |
| Gemini `400 InvalidArgument` with `allowed_function_names` should be a subset | the same turn later answered | a tool is listed in the agent config but not declared to the model (for example a selfie tool) | Name the agent, check whether answers follow; owner is the agent-config owner. *(seen 2×: https://livexai.slack.com/archives/C079BU33H0W/p1794459133056959 and the 2026-11-12 digest; both sampled conversations later answered)* |
| `Could not find agent with id` | a storefront or widget is the caller | a malformed agent id from the caller | See error-digest-categories.md (Wyze). *(seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1794271228221859)* |
| `Error creating tickets in create_zendesk_ticket` with 4xx | Wyze agent, "suspended requester" | known Zendesk-side rejection | A human decided the Wyze suspended-requester case is known and should not count toward coverage; still check other Zendesk errors. *(seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1793993173960419, Tanmesh)* |
| Elasticsearch version conflict then HTTP 500 on a profile update | other updates to the same record succeeded | a concurrent write lost the race; this update failed | Say recovery of that request is unverified. *(seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794459133056959 - bot finding)* |

## conversation-avatar and chat-engine-avatar

Success = the session produced speech or video output after the error
(frames or an audio start) and did not end with a reconnect timeout.

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| TTS error `model_not_found` for one agent's language | zero audio frames, no fallback, other languages fine | an invalid `tts_model_id` in the agent's voice config | Name the agent and language; config fix by the agent owner. *(seen 1×: Fernando fixed `eleven_flash_v3` to `eleven_v3` on 2026-11-13 12:29 PST in https://livexai.slack.com/archives/C079BU33H0W/p1794544244431139; code: conversation-agent@origin/main app/tts/tts_factory.py:82 `tts_model_id`)* |
| `Timeout during LLM language detection` in `chat-engine-avatar` | the session spoke | same noise as chat-engine | See chat-engine row. *(seen 2×: digest of 2026-11-12/13)* |
| Reconnect-timeout or room-disconnect lines | one device or room repeats | a device or network problem, not a service fault | Check whether one device id dominates. *(unverified)* |
| Errors only on agents named test, demo or "EXPERIMENT NOT PRODUCTION" | | non-customer traffic | Say so; Low. *(seen 1×: digest threads of 2026-11-12)* |

## embedding-server

Success = the caller received a non-empty vector. On total failure the
service returns `{}` with HTTP 200, so a 200 does not prove success.
*(code: embedding_server@origin/main app/embedding.py:470 returns `{}`, app/main.py "If no result, return empty dict")*

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| `Gemini ... 503 UNAVAILABLE` or `model failed with exception` then `All embedding attempts failed for models` | the next batch succeeded | an upstream provider blip; one failure chain is several log lines | Count `All embedding attempts failed` (chains), not total lines; check whether the caller (ingestion or search) retried. *(seen 1×: bot finding for 15 entries = 3 batch chains, thread linked from https://livexai.slack.com/archives/C079BU33H0W; the card link was not retained, so (unverified) beyond the code)* |
| `Embedding error, <model>, <texts>` | one customer's content repeats | content-specific rejection | Name the content owner; sample the caller. *(unverified)* |
| Redis `get`/`set` errors | embeddings still returned | cache degraded, not a failure | Low. *(code: embedding_server@origin/main app/embedding_cache/embeddeding_cache.py:195-262)* |

## Known causes

Before theorising, call `investigation_lookup` with a signature of the form
`<service> | <operation> | <error class>` (for example
`chat-engine | generate answer | model race timeout`) and again with the top
message shape. A hit is a lead: confirm the same message shape and the same
workload in the current window, treat its priority and "resolved" as stale,
and carry its owner only if a human accepted it.

## Severity

Priority is `provisional: true` whenever any number below is used.

- **High**: the impact sample shows user-facing failures in at least 3 of 5
  checked conversations or requests (proposed), or the same failure repeats
  across at least 3 consecutive 10 min buckets (proposed), on live (not test)
  traffic; or any panic on an authenticated customer route with no 2xx retry.
- **Medium**: some sampled operations failed (1-2 of 5, proposed) or failures
  are confined to one agent or customer, or recovery of a failed operation is
  unverified.
- **Low**: every sampled operation succeeded or recovered, the error is a known
  harmless shape above, or the traffic is test/demo.
- **Unknown**: the impact sample could not be taken. Name the check and the
  evidence needed. Unknown is not Low.

The conversation-avatar row of the former severity policy is folded in here
(Medium or above if sessions end without audio or more than 3 sessions fail,
proposed; Low for recoverable errors or client-cancel noise).

## Owner

- chat-engine, self-hosted Qwen: Dagang Wei responded and ran the fix (https://livexai.slack.com/archives/C0BM1L6D755/p1794510349507229).
- Wyze storefront ids: Hugo Yin responded (see error-digest-categories.md).
- English avatar TTS config (Sojitz/Pier One): Fernando fixed it.
- api-gateway, embedding-server, conversation-avatar otherwise, and every
  other case: Unassigned (TBD). No human accepted these in the threads read.

## Expected window / when the classification is wrong

A transient provider or LLM blip clears within one to two 10 min buckets; a
config error persists until someone publishes. If the count is still above the
threshold after 30 min, or the sample shows failed answers where this table
says noise, the row is wrong: restart from step 1 with that row ruled out.
