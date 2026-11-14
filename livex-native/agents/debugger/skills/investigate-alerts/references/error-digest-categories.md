# Playbook: LiveX Reporting error digests

Provenance tags as in [gke-application-errors.md](gke-application-errors.md).

## Match

Messages from the "LiveX Reporting" bot in #chat-engine-alerting-prd
(C09N85B5664):

- Digest: `Total N errors in chat-engine/chat-engine (last 7 hr)` (also
  `(last 15 hr)`, `(last 16 hr)`) and the same for
  `chat-engine-avatar/chat-engine`, followed by lines `<count> × <category>`.
  Posted about every 8 hours (08:00, 16:00, 00:00 PST); about 3 per day.
- Single-category cards: `<count> × <category>` with `Affected Agents:` and
  `Service:`.

Digests count log entries. The same event can appear in two categories (the
150-count `No model-race winner` pair on 2026-11-09 were the same 150 traces,
https://livexai.slack.com/archives/C09N85B5664/p1794240015992969): never sum
them.

## Workload

| Digest label | resourceType | resourceLabels (plus project_id `livex-copilot-prd`, location `us-central1`) |
| --- | --- | --- |
| `chat-engine/chat-engine` | `k8s_container` | namespace_name `chat-engine`, container_name `chat-engine` |
| `chat-engine-avatar/chat-engine` | `k8s_container` | namespace_name `chat-engine-avatar`, container_name `chat-engine` |

The digest's own Logs link carries the window; use its timestamps as
`start`/`end` (split into windows of at most 6 hours for `count`, 1 hour for
`errors`/`context`).

## First checks (in order; stop when the timeline explains the symptom)

1. **Inventory.** List every category in the digest with its count and service.
   Mark pairs that share a count (likely the same events at two layers).
2. **Rank by user impact, not by count.** Check the category sections below for
   whether the handler fails the user's request. Pick the top 3 to verify.
3. **Size and onset.** For each picked category,
   `livex_gcp_logs_read {mode:"count", resourceType, resourceLabels, phrases:[<literal phrase>], start, end}`
   over the digest window; `buckets` show whether it is a burst or steady.
4. **Client effect sample** per picked category: run the Client effect check below.
5. **Test versus live.** Agents named test, demo, `EXPERIMENT NOT PRODUCTION`,
   `test_run` or `test_suite` are not customer exposure.

## Categories

Each: phrase; handler behaviour; what to check; Slack provenance.

### Timeout during LLM language detection (digest top item most days)

- Phrase: `Timeout during LLM language detection`. Counts seen: 1,050
  (2026-11-09 15 hr), 2,960 (11-12 16 hr), 1,112 and 109 (11-12/13 7 hr).
- Handler: caught; returns language "unknown" and the request continues after a
  2 s wait. *(code: chat-engine@origin/main app/utilities/language_detector.py:526-532, timeout default 2 at :441)*
- Check: a large steady count with answered turns is noise; a spike together
  with `No model-race winner` or `Request timed out` points at the LLM provider
  or the self-hosted model (see below). A human noted it is "back" and tagged
  Yao Zhao on 2026-11-09 (https://livexai.slack.com/archives/C09N85B5664/p1794240015992969) without a recorded conclusion.
- Affected: the turn has no saved answer other than the generic error text. Owner: Unassigned (TBD).

### No model-race winner after timeout budget / TimeoutError: No model-race winner after budget

- Phrase: `No model-race winner after`. Two digest lines often cover the same events.
- Handler: raises; the user gets the generic error answer. *(code: chat-engine@origin/main app/agent/parallel_tool_agent.py:907; budget 10 s, app/schemas/agent_config/tool_agent_config.py:35)*
- Check: affected conversations (count once), live versus `test_run`, whether
  the models' providers were failing. *(seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1794240015992969 - bot finding, sampled conversation was a test run)*
- Affected: the conversation got the generic error answer. Owner: Unassigned (TBD).

### Request timed out / APITimeoutError

- Phrases: `Request timed out`, `APITimeoutError`. Bursts of 324-400 each on 2026-11-12 (7 hr digest).
- Handler: caught inside the race; the user is affected only if no other model
  answers. Precedent: self-hosted Qwen stopped answering for about 8 h on
  2026-11-12 (Dagang Wei, https://livexai.slack.com/archives/C0BM1L6D755/p1794510349507229, LX-12525).
  Whether a later burst has the same cause is unverified.
- Affected: no model answered the turn (the generic error answer was saved). Owner: Dagang Wei responded to the Qwen outage; otherwise Unassigned (TBD).

### You have reached your specified API usage limits

- Phrase: `You have reached your specified API usage limits`. Counts: 1,396 and 1,413 (2026-11-12 16 hr); 69 per card for El Camino agents.
- Handler: the provider rejects every request until the limit resets; other
  models in the race may still answer. Related line: `All models finished without a valid completion`; `Our servers are currently overloaded`.
- Check: which provider and agents; whether a different model produced the
  answer; the El Camino Mountain View agent is marked experimental.
  Tracking: LX-12524 (a dedicated alert for Anthropic spend-limit errors,
  filed by Tanmesh, https://livexai.slack.com/archives/C09N85B5664/p1794509383598319). Do not claim a shared account from similar text alone.
- Affected: no model answered the turn. Owner: Unassigned (TBD).

### Input should be a valid string for avatai.voice_id

- Phrase: `Input should be a valid string for avatai.voice_id`. Count 944 (2026-11-13 7 hr); one agent id dominated (ECH Mountain View per the bot thread).
- Handler: the agent config fails validation when `avatai.voice_id` is null
  (the field defaults to `""`, so only an explicit null fails). Repeated config
  refreshes inflate the count; two conversation-start 404s correlated closely.
  *(code: chat-engine@origin/main app/schemas/agent_config/base.py:667; seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1794607813481969 - bot finding; Dagang Wei reported publishing that config at 21:53 UTC, causation not established)*
- Check: first and last occurrence, distinct conversation starts that failed
  versus refresh repeats, whether the config was republished.
- Affected: a conversation start failed; a config refresh log alone is not. Owner: Unassigned (TBD).

### Could not find agent with id

- Phrase: `Could not find agent with id`. Small counts (4-15 per digest).
- Handler: logged and the request is answered 404. *(code: chat-engine@origin/main app/database/agent.py:43,76)*
- Cause seen: the Wyze storefront sends a malformed `agent_id` to
  `/api/v1/product_suggested_questions/` - a leading newline (`%0A`) in one
  case, a Shopify Liquid error text in another (missing
  `snippets/wyze-livex-agent-id.liquid`). Hugo Yin: no backend change needed;
  a widget trim fix (chatbox-js PR 1528) and a Wyze theme fix.
  *(seen 1×: https://livexai.slack.com/archives/C09N85B5664/p1794271228221859 - Hugo Yin, Fernando, Rahul Dhiman, Tanmesh)*
- Affected: the caller got the 404 (suggested questions only, unverified for other callers). Owner: Hugo Yin responded.

### Agent config validation: llm_config.backup_trigger_delay, role_template

- Phrases: `Input should be a valid number for llm_config.backup_trigger_delay`, `Input should be a valid string for role_template`, `Failed to create workflow: Could not initialize workflow`.
- Handler: workflow initialisation fails for that agent. *(seen 1×: the 2026-11-11 digest; a human thread asked whether it is critical, no conclusion recorded)*
- Check: one agent id versus many; whether a publish preceded it.
- Affected: a conversation with that agent failed to start or answer. Owner: Unassigned (TBD).

### NoneType errors (`object of type 'NoneType' has no len()`, `no attribute 'startswith'`)

- Handler: a background task or conversation update is lost. *(unverified: the cards named a test agent, Puma LiveX Test)*
- Check: agent name; whether the conversation still answered.
- Affected: the conversation did not answer. Owner: Unassigned (TBD).

### Others in the digests (unmined)

`Connection timeout to host`, `Invalid JSON in request`, `Error in new_conversation, getting payload`, `Could not load product knowledge for account`, `Could not find asset snippets/...` (Wyze theme, see above), `NotFoundError`. First check: the same client effect sample; affected only when a failed user operation is shown.

## Known causes

Call `investigation_lookup` with `chat-engine | <operation> | <category in plain words>` (for example `chat-engine | generate answer | api usage limit`). A hit is a lead: re-confirm the phrase, the agent and the window, and ignore its resolved state.

## Client effect check

Per picked category, sample N=5 conversations by default (proposed). Take ids
with `livex_gcp_logs_read {mode:"errors", resourceType, resourceLabels, textContains:"<phrase>", start, end, limit:50}`
over one hour of the digest window, then one `mode:"context"` read per id
with `conversationId` over that turn plus a few minutes. Count a conversation
once even when two categories name it. A conversation is **affected** as the
category's "Affected" line says; for an unmined category, when the user did
not get an answer. Live agents first; `traffic: "test"` only when every
affected conversation is on a test or demo agent.

Put the category you judge most serious in the envelope's main fields and up
to four other picked categories in `alternates`, each with its own `title` and
facts (and `knownRef` when known). List any remaining categories in the
report.

## Sustained check

Per category, `sustained` is true when it was also in the previous digest for
the same service, or its `count` buckets show it in at least 3 hours of this
digest's window (proposed). A burst confined to one or two hours is false.

## Known patterns

`knownRef` is the id cell, copied verbatim. Use a `fixed` row as `known:
"fixed"` only when the symptom is absent from the latest completed window;
otherwise `known: "ongoing"` with the same reference. A ticket a person filed
(for example LX-12524 for API usage limits) is `known: "ongoing"` with the
ticket id. Only people edit this table; suggest a new row in the thread.

| id | pattern | state (fixed or harmless) | since | source |
| --- | --- | --- | --- | --- |
| `pattern:wyze-malformed-agent-id` | `Could not find agent with id` with a malformed id (leading newline or Liquid error text) from the Wyze storefront | fixed | 2026-11-10 | https://livexai.slack.com/archives/C09N85B5664/p1794271228221859 (Hugo Yin: widget trim fix chatbox-js PR 1528 and a Wyze theme fix) |
| `pattern:qwen-self-hosted-outage` | `Request timed out` / `APITimeoutError` burst on Wyze or Ego agents from the self-hosted Qwen LLM | fixed | 2026-11-12 | https://livexai.slack.com/archives/C0BM1L6D755/p1794510349507229 (Dagang Wei: fix and watchdog rolled out; LX-12525) |

## Alert severity

The digest carries none: use `alertSeverity: "error"` for every category.
`alertClass` is `error-digest-categories`; `service` is the namespace of the
digest label: `chat-engine` or `chat-engine-avatar`.

## Owner

Per category. Hugo Yin (Wyze widget ids) and Dagang Wei (self-hosted Qwen)
responded in threads; everything else Unassigned (TBD).

## Expected window / when the classification is wrong

Provider caps and self-hosted outages last hours; config errors last until a
publish. If a category called noise shows failed answers in the impact sample,
reclassify it and name the evidence.
