# Team severity policy

> **DRAFT — thresholds proposed by Claude from the alert text; confirm or edit before relying on them.**

The team owns this table. Edit a row to change how the debugger assigns
`priority`. While this file is marked DRAFT, every priority taken from it is
`provisional: true`. "(proposed)" marks a number or rule that is a guess, not a
fact from the alert text.

## How to use

1. **Match the alert to a row.** Use the exact Google Cloud Monitoring alert
   title as it appears in Slack, plus the row's match rule. Match on title, not
   on a similar-looking error.
2. **Measure** with `livex_gcp_logs_read` over the alert's window (from the
   alert text), as the row's "Measurement" column says. Cloud Monitoring metric
   values are not readable, so counts are log samples bounded by the read caps:
   say "sampled" and keep the priority `provisional: true`.
3. **Assign the row's priority** (High, Medium or Low maps to `high`, `medium`,
   `low`) from the measured values. Set `provisional: true` when any
   measurement the row needs is missing or unreadable, or while this file is a
   DRAFT. Name the missing check in the summary.
4. **If no row matches**, keep the existing rule: give a provisional priority or
   `unknown`. Unknown priority is not low priority.
5. **Owner.** Fill `owner` with the row's owner when it is not "Unassigned
   (TBD)". Otherwise use `Unassigned`.

A row's rules are a starting point. Impact, scope and workarounds still count;
volume alone does not set priority.

## Rows

| Alert match | Measurement | High | Medium | Low | Owner | Notes |
| ----------- | ----------- | ---- | ------ | --- | ----- | ----- |
| Title: `Phone call notes missing call data`. Match rule: title contains "Phone call notes missing call data" (Zendesk "Phone Call Received" webhooks with no saved call data). | Logs over the alert's 3-hour window (the alert fires when the share of Zendesk "Phone Call Received" webhooks with no saved call data is above 0.75): count conversation-agent `[PHONE_CLOSE] Closing conversation`, chat-engine `Storing phone call data`, and `[PHONE_CLOSE] Close request failed`, per hour. LiveX calls that closed but were not stored, or close requests that failed, are LiveX failures; calls with no close at all are likely non-LiveX callers. | Close or store failures for LiveX calls in at least 2 consecutive hours (proposed), or closes far outnumber stores (for example fewer than half stored, proposed). | Alert open but logs show LiveX calls closing and storing normally (mostly non-LiveX callers), or failures in a single hour only (proposed). | Ratio near the normal share of about 0.4 (callers who did not come through a LiveX phone agent): expected. | Unassigned (TBD) | Normal share is about 0.4. During the LX-11451 incident (telephony worker not closing calls in chat-engine) it was 0.98. A high share alone does not show LiveX calls are affected; check the logs. |
| Title: `GKE conversation-avatar: more than 5 application errors in 10 minutes`. Match rule: title starts with "GKE conversation-avatar" and mentions application errors. | Logs over the alert's 10-minute window (alert fires above 5 application errors): the error entries for the conversation-avatar container, grouped by session/room; whether each affected session later produced audio/speech output; how many distinct sessions failed; whether the errors are client cancellations. | Sessions end without audio/speech output, or more than a few sessions fail (proposed threshold: more than 3 sessions). | Errors affect sessions that later recover. | Only recoverable errors or client-cancel noise. | Unassigned (TBD) | The alert text says the count includes recoverable errors and client cancellations and does not measure failed requests. Check request outcomes before assigning priority. |
