# Team severity policy (index)

> **DRAFT — thresholds proposed by Claude from the alert text and Slack
> history; confirm or edit before relying on them.**

The severity rules now live in each playbook's **Severity** section, next to
the checks that produce the numbers. Edit the playbook to change how the
debugger assigns `priority`. While this file is marked DRAFT, every priority
taken from a playbook is `provisional: true`. "(proposed)" marks a number or
rule that is a guess, not a fact from the alert text.

## How to use

1. **Match the alert to a playbook.** Use the exact Google Cloud Monitoring
   alert title as it appears in Slack, or the digest/report phrase, with the
   table below. Match on title, not on a similar-looking error.
2. **Measure** with `livex_gcp_logs_read` over the alert's window (from the
   alert text), as the playbook's first checks say. Cloud Monitoring metric
   values are not readable, so counts are log samples bounded by the read caps:
   say "sampled" and keep the priority `provisional: true`.
3. **Assign the playbook's priority** (High, Medium or Low maps to `high`,
   `medium`, `low`) from the measured values. Set `provisional: true` when any
   measurement the playbook needs is missing or unreadable, or while this file
   is a DRAFT. Name the missing check in the summary.
4. **If no playbook matches**, keep the existing rule: give a provisional
   priority or `unknown`. Unknown priority is not low priority.
5. **Owner.** Fill `owner` with the playbook's owner when it names a person
   who responded; "Unassigned (TBD)" means use `Unassigned`.

A playbook's rules are a starting point. Impact, scope and workarounds still
count; volume alone does not set priority.

## Index

| Alert | Playbook | Severity section |
| ----- | -------- | ---------------- |
| `GKE <service>: more than N application errors in 10 minutes` (api-gateway, chat-engine, chat-engine-avatar, conversation-avatar, embedding-server) | [gke-application-errors.md](references/gke-application-errors.md) | `## Severity` (includes the former conversation-avatar row) |
| `Phone call notes missing call data`, `Phone call close request failed` | [phone-call-notes.md](references/phone-call-notes.md) | `## Severity` (includes the former Phone-call-notes row) |
| "LiveX Reporting" digests and category cards in #chat-engine-alerting-prd | [error-digest-categories.md](references/error-digest-categories.md) | per category, plus `## Severity` |
| `Low Conversation Volume Report` | [low-conversation-volume.md](references/low-conversation-volume.md) | `## Severity` |
| `Query Rewrite Error`, `Error while generating answer`, `Error in generating ticket`, `Salesforce client init failed` | [log-match-alerts.md](references/log-match-alerts.md) | `## Severity` |
