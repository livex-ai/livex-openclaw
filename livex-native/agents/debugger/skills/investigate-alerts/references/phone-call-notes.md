# Playbook: phone call notes and call close

Provenance tags as in [gke-application-errors.md](gke-application-errors.md).

## Match

- `Phone call notes missing call data` (Cloud Monitoring; condition "Over 75% of
  phone webhooks found no call data in 3 hours"; alert body says the normal
  share is about 0.4 and that it was 0.98 during LX-11451, 2026-09-02 to
  2026-09-25). Seen 1× in the window: https://livexai.slack.com/archives/C079BU33H0W/p1794630823217059
  (bot card only: "impact verification blocked", no human reply).
- `Phone call close request failed` (log-match, severity Warning; message
  `[WARNING] [PHONE_CLOSE] Close request failed for conversation <id>: <ErrorType>: ...`).
  Seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794523236909679
  (`ClientOSError: [Errno 104] Connection reset by peer`; bot finding: the call
  had transferred before the reset; no human reply).

## Workload

| Side | resourceType | resourceLabels (plus project_id `livex-copilot-prd`, location `us-central1`, cluster_name `copilot-prd-cluster`) |
| --- | --- | --- |
| Telephony worker (conversation-agent) | `k8s_container` | namespace_name `conversation-telephony`, container_name `conversation-telephony` |
| chat-engine | `k8s_container` | namespace_name `chat-engine`, container_name `chat-engine` |

The log-match alert also names the pod and the conversation id; use the id for
`context` reads.

## First checks (in order; stop when the timeline explains the symptom)

Window W = the 3 hours before the alert notification (UTC). The Monitoring
share is unreadable; build the numerator and denominator from logs.

1. **Closes started and failed.** `livex_gcp_logs_read {mode:"count", resourceType:"k8s_container", resourceLabels:<telephony>, phrases:["[PHONE_CLOSE] Closing conversation","[PHONE_CLOSE] Close request failed","retrying once","[PHONE_CLOSE] No Twilio call SID"], start, end}` over W; the `buckets` give hourly counts.
2. **chat-engine side.** Same call on the chat-engine labels with
   `phrases:["No call data found for phone number","Error in close_phone_call_conversation","Storing phone call data"]`.
   Never quote a phone number from a returned sample. `Storing phone call data`
   is a debug log in the code, so a zero count may mean the level is not
   emitted, not that nothing was stored: report it as "unreadable" unless
   `Closing conversation` counts are also zero.
3. **Impact sample (N=5 closes, proposed).** Take up to 5 conversation ids
   from step 1's `samples` (include any `Close request failed` ids first).
   For each: `livex_gcp_logs_read {mode:"context", resourceType, resourceLabels:<telephony>, conversationId, start, end}`
   to see close start, retry and failure; then the same id on the chat-engine
   labels to see whether `close_phone_call_conversation` returned. Report
   `n_failed / n_checked`. The Zendesk ticket and notes cannot be read: say
   "notes persistence unverified" rather than "recovered".
4. **Normal share.** Calls with no close at all in the telephony logs are
   callers who never reached a LiveX phone agent (the alert's "normal" 0.4).
   If closes are present and `No call data found` is mostly for numbers with
   no close, it is the normal share.

## Correlation table

| If you see | And | It usually means | Then |
| --- | --- | --- | --- |
| Many `Closing conversation`, few or no `Close request failed` | `No call data found` count about 40% of webhooks | the normal share | Low; say the alert is at baseline and why. *(code: conversation-agent@origin/main app/session_builder/telephony_session_builder.py:293; alert text)* |
| `Close request failed` in at least 2 consecutive hourly buckets | chat-engine shows `Error in close_phone_call_conversation` or no matching request | the close path to chat-engine is broken, calls end with no notes | LX-11451-like. Check the chat-engine 5xx and recent deploys of either side. *(seen 1× in the alert text: LX-11451; current recurrence unverified)* |
| One `Close request failed` with `ClientOSError ... Connection reset by peer` | the worker logged `retrying once` earlier | a connection reset; the worker retries once, then gives up | One call lost its notes; conversation stays open until the idle sweep. Impact: that call. *(code: conversation-agent@origin/main app/chat_management/chat_engine_client.py:206, retry on `ClientOSError`, 2 attempts; seen 1×: https://livexai.slack.com/archives/C079BU33H0W/p1794523236909679)* |
| `Close request failed` with `TimeoutError` | | the 5 s bound on the close elapsed | Check chat-engine latency for `close_phone_call_conversation`. *(code: conversation-agent@origin/main app/session_builder/telephony_session_builder.py:282, `wait_for(..., timeout=5)`)* |
| `[PHONE_CLOSE] No Twilio call SID` | | the call has no SID; the close still runs | Not a failure by itself. *(code: telephony_session_builder.py:292)* |
| Close returned 200 but no notes | the caller number or chat history was empty | chat-engine skips storage when either is empty | Say notes were skipped, not failed. *(code: chat-engine@origin/main app/api/chat/voice_storage_params_manager.py:20-30)* |

## Known causes

Call `investigation_lookup` with `conversation-telephony | close phone call | close request reset` and with `chat-engine | store phone call data | missing call data`. A hit on LX-11451 is a lead only; confirm the telephony close counts first.

## Severity

All numbers are proposed; priority is `provisional: true`.

- **High**: close failures or `Error in close_phone_call_conversation` for LiveX
  calls in at least 2 consecutive hourly buckets (proposed), or closes far
  outnumber stored (fewer than half stored, proposed), or 2 or more of the 5
  sampled closes failed (proposed).
- **Medium**: the alert is open but closes and stores look normal (mostly
  non-LiveX callers), or failures appear in a single hour only (proposed), or a
  single failed close whose call was a customer call.
- **Low**: ratio near the normal 0.4 with no failed closes, or a single failed
  close on a test agent.
- **Unknown**: the telephony logs could not be read.

(This section folds in the former "Phone call notes missing call data" row.
Its "normal share about 0.4" and the LX-11451 0.98 figure come from the alert
text; the row's thresholds were proposals.)

## Owner

Unassigned (TBD). No human responded in the two threads read.

## Expected window / when the classification is wrong

A reset-then-retry clears in seconds; a broken close path persists until a fix
ships (the LX-11451 episode lasted about 3 weeks). If the 3 h share stays high
after the telephony counts look normal, the alert's own condition is measuring
something this playbook does not (for example a Zendesk webhook change): report
that and stay Unknown.
