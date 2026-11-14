# Team priority policy (pointer)

> **DRAFT — thresholds proposed by Claude from the alert text and Slack
> history; confirm or edit before relying on them.**

The debugger does not choose a priority. It reports facts in the
`LIVEX_ALERT_SUMMARY_V3` envelope, and the Gateway computes High, Medium or
Low from them with the team-owned table in `livex-native/config/priority-policy.json`
(rules in order, first match wins). Change the table there, not here; changing
it needs no code change.

## The three facts that decide the priority

1. **Client effect** — derived by the Gateway, never written by the model.
   Clients were affected when `sampleAffected` is above 0. "No client effect"
   counts only with `clientEffectVerified` true, at least `minSample` (3)
   sampled, and at least one successful logs read in the thread. It is lost for
   the whole thread (narrowing later does not undo it) when a read fails for a
   reason other than rejected arguments, a `count` returns `complete: false`, or
   an ID-scoped read (`conversationId`, `jobId`, `roomId`, `traceId`,
   `insertId` or `insertIds`) loses entries (`truncationReasons` has `row-limit`
   or a result-byte limit). A capped listing read without an id is a sample
   frame and does not block it; field-only truncation never does. Anything else is "not verified": a
   user-facing alert is rated up (Medium), a background one stays Low.
   User-facing is looked up by `service`, then `alertClass`; today only
   `embedding-server` is not user-facing.
2. **Known issue** — `known` with a `knownRef`: a Slack thread link where a
   person said so, a ticket id, or `pattern:<id>` from the playbook's Known
   patterns table (`harmless` only from a pattern). Fixed or harmless lowers
   the priority when no client was affected; it never lowers it when clients
   were affected. Any other reference is treated as not known.
3. **The alert itself** — `alertSeverity` (from the alert text, else the
   playbook's Alert severity section) and `sustained` (the playbook's
   Sustained check). An error that keeps recurring with no client effect
   found is Medium unless it is a known fixed or harmless pattern, which is Low.

`traffic: test` makes an affected alert Low, or Medium when it was marked
known-fixed but is still affecting users; `scope: multiple` or a majority of
the sample affected makes it High.

## Where each playbook defines its facts

| Alert | Playbook |
| ----- | -------- |
| `GKE <service>: more than N application errors in 10 minutes` | [gke-application-errors.md](references/gke-application-errors.md) |
| `Phone call notes missing call data`, `Phone call close request failed` | [phone-call-notes.md](references/phone-call-notes.md) |
| "LiveX Reporting" digests and category cards in #chat-engine-alerting-prd | [error-digest-categories.md](references/error-digest-categories.md) |
| `Low Conversation Volume Report` | [low-conversation-volume.md](references/low-conversation-volume.md) |
| `Query Rewrite Error`, `Error while generating answer`, `Error in generating ticket`, `Salesforce client init failed` | [log-match-alerts.md](references/log-match-alerts.md) |

Each has **Client effect check**, **Sustained check**, **Known patterns** and
**Alert severity** sections. Only people edit them; the debugger suggests a
change in the thread.
