# Debugger priority engine — design

Date: 2026-11-14 · Branch: `claude/pr50-parity` (PR #53) · Status: reviewed, awaiting owner approval

## Intent

The LiveX debugger (an OpenClaw agent in Slack, DEV) investigates an alert when
someone mentions it. The team's main need from it is **the correct priority on
each alert**. Today it often answers "Priority: Unknown", which gives nothing
to sort by.

This is the first project of a larger aim the owner calls "AI SRE". The others
(listed under Non-goals) feed this one and are designed separately.

## What "correct priority" means (decided with the owner)

Priority depends on three facts:

1. **Alert severity** — how bad the alert itself says it is.
2. **Known issue** — whether the team already knows about this problem.
3. **Client-side effect** — whether a customer or end user felt it.

Rules, following the on-call kit (anthropics/oncall-kit) where the owner said
to follow it:

- Client effect **now** decides the level.
- Known **and still ongoing** keeps the level; the card links the existing case
  and its owner and no parallel investigation starts.
- Known **and fixed, or a known harmless pattern** lowers the level, and the
  card says a discount was applied.
- When client effect cannot be verified: lean **up** if the alert is on a
  user-facing path, lean **down** if it is not. Never "Unknown".
- Every judgment leaves a trace on the card: sample size, discount, confidence.
- A read that failed is never treated as healthy.

## Goals

- Every card carries High, Medium or Low. "Unknown" no longer exists.
- Two alerts with the same three facts always get the same priority.
- The card shows the three facts under the priority, so a reader sees why.
- The team owns the rule table in one small file and can change it in a
  one-line edit.
- Old alerts can be replayed through the table as a test.

## Non-goals (later AI SRE projects, in proposed order)

1. Owner discovery: memory of who responded, a "who handled this before" lookup.
2. Alert correlation and storms: one investigation for alerts sharing a cause.
3. Log access redesign: letting the debugger pass its own read-only filter.
4. Handoffs, daily summaries, and a replay-based evaluation set.
5. Paging people, declaring incidents, or any change to production. The
   debugger stays read-only.

## Anti-goals

- A priority the model picks by judgment. That is what drifts today.
- A card that hides that it guessed. A rating from a small sample must say so.
- Lowering a priority because a read failed or hit a cap.

## Constraints

- Host is OpenClaw 2026.10.5 with the Codex runtime; only plugin APIs proven on
  that version may be used (hooks `before_prompt_build`, `reply_payload_sending`,
  `message_sent`, `before_tool_call`, `after_tool_call`; `registerTool`;
  `api.runtime.state.openKeyedStore` and `resolveStateDir`). `openKeyedStoreV2`
  does not exist there.
- The debugger is read-only and reads untrusted text (logs, Slack, alert docs).
  Nothing in that text may change the priority rules.
- Cloud Monitoring metric values are not readable. Evidence comes from
  `livex_gcp_logs_read` (errors, context, `textContains`, `count`).
- Log reads are capped; counts can be lower bounds. The table must cope with
  "could not verify".
- The card format (PR #1 layout, colored bar) stays.

## Approaches considered

1. **The model decides, guided by written rules.** Nothing new to build, but
   the model drifts from its rules (it had evidence of no client effect and
   still said Unknown), and a judgment cannot be tested.
2. **The model gathers three facts; code sets the priority.** Consistent,
   testable, never Unknown, the table is a file the team owns. More to build.
   **Chosen by the owner.**
3. **A simple agent with direct shell access.** Least code, but the priority is
   still a model judgment, and it opens network access to an agent that reads
   untrusted text.

Dropped early: the model proposes and code overrides on disagreement (two
answers to reconcile, no gain over 2).

## Design

### 1. The facts the debugger reports

The final reply keeps its envelope shape (marker line, one JSON line, blank
line, full report) and moves to `LIVEX_ALERT_SUMMARY_V3`. The model no longer
writes `priority` or `provisional`. It writes facts:

| Field | Values | Notes |
|---|---|---|
| `alertClass` | a playbook id, e.g. `gke-application-errors`, or `unclassified` | Selects the playbook |
| `service` | e.g. `api-gateway`, `chat-engine`, `embedding-server`, or `none` | From the alert's labels; with `alertClass` it decides user-facing |
| `alertSeverity` | `error`, `warning`, `info` | From the alert text; when the text has none, the playbook supplies a fixed value |
| `sustained` | boolean | True when the playbook's "sustained" check passed (recurs across windows) |
| `known` | `no`, `ongoing`, `fixed`, `harmless` | See "Known issue" below |
| `knownRef` | string, required unless `known` is `no` | A ticket id, a Slack thread link, or a playbook pattern id |
| `sampleChecked`, `sampleAffected` | integers | Conversations or calls sampled, and how many were affected |
| `scope` | `single`, `multiple`, `unknown` | Customers or agents affected |
| `traffic` | `live`, `test`, `unknown` | Whether the affected traffic is real users or test/demo |
| `clientEffectVerified` | boolean | False when the debugger could not check (no readable evidence) |

The model does not write a yes/no "client effect". Code derives it:
`sampleAffected > 0` is **yes**; `sampleAffected == 0` with
`sampleChecked >= minSample` and no capped or failed read is **no**; anything
else is **unverified**.

`title`, `signature`, `summary`, `nextAction`, `owner`, `checkedWindow`,
`evidenceUrl` and `resolved` stay as in V2.

### 2. The rule table (team-owned)

One file, `livex-native/config/priority-policy.json`, shipped in the image and
read by the card plugin. It holds:

- `userFacing`: map of `alertClass` + `service` → boolean. Starting values
  (accepted by the owner): api-gateway, chat-engine, chat-engine-avatar,
  conversation-avatar, phone calls and low conversation volume are user-facing;
  embedding-server is not. Anything unlisted or `unclassified` counts as
  user-facing (lean up).
- `minSample`: how many sampled items make a "no client effect" result count
  (proposed: 3).
- `majority`: the share of the sample that counts as "most" (proposed: half).
- `rules`: evaluated in order, first match wins. Starting table (the split in
  rows 1 to 3 was accepted by the owner):

| # | Client effect | Other conditions | Priority | Card note |
|---|---|---|---|---|
| 1 | yes | test or demo traffic | Low | "affected traffic is test/demo" |
| 2 | yes | live, and `scope` multiple or affected ≥ majority of sample | High | "ongoing" adds the known reference |
| 3 | yes | live, single customer or a minority of the sample | Medium | same |
| 4 | yes | `known` fixed or harmless | at least Medium | "marked known but users still affected" |
| 5 | unverified | user-facing | Medium | "impact not verified; rated up" |
| 6 | unverified | not user-facing | Low | "impact not verified; background path" |
| 7 | no | `known` fixed or harmless | Low | "known; discounted" |
| 8 | no | `alertSeverity` error and `sustained` | Medium | "no user impact found; recurring" |
| 9 | no | otherwise | Low | "no user impact found" |

`traffic` unknown is treated as live. Row 4 only raises: it applies after rows
1 to 3 and lifts a Low to Medium.

Every number and row here is a proposal for the owner to confirm; changing
them needs no code change.

### 3. Where the priority is computed

In the card plugin (`livex-slack-summary`), in its existing
`reply_payload_sending` step, before rendering. A pure function
`computePriority(facts, policy)` returns `{ priority, ruleId, notes }`. The
plugin also enforces (the author's call: facts are cross-checked, not trusted):

- The card plugin already records what `livex_gcp_logs_read` returned in each
  thread (it does this to verify evidence links). It extends that record with:
  how many reads succeeded, and whether any was capped, incomplete or failed.
- With no successful read in the thread, client effect is **unverified**,
  whatever the model wrote.
- If any read was capped, incomplete or failed, a derived **no** becomes
  **unverified**. A read that failed can never lower a priority.
- `known` other than `no` needs a `knownRef` of an accepted kind (next
  section); otherwise it is treated as `no`. Text found in logs or alert
  documentation can never justify `fixed` or `harmless`.
- An invalid envelope renders the existing "could not format" notice, as today.

The memory plugin (`livex-investigations-lite`) reads the same V3 envelope and
stores the facts with the case. It needs the computed priority too; how the two
plugins share `computePriority` is left to the builder (see below).

### 4. The card

Unchanged layout, with one added line under Priority:

```
Title: api-gateway errors: missing agent configs
Priority: 🟡 Medium
Why: client effect not verified (0 of 2 sampled, a read was capped) · known: no · alert: error, recurring
Next action: … (Owner: …)
Summary: …
Evidence: Logs · Checked window: …
```

The colored bar follows the computed priority (red, amber, gray; green when
resolved). Agent amendments are recomputed the same way.

### 5. Known issue: where it comes from

Accepted by the owner: the debugger's own earlier card is a lead, not "known".
An alert is `known` only when one of these holds, and `knownRef` names which:

- a person said so in the current thread, or in the thread of the earlier case
  (a Slack thread link);
- a ticket exists for it (a ticket id a person posted);
- it matches a "known patterns" entry in the alert's playbook (the pattern id).

`ongoing` versus `fixed`: `fixed` needs a person saying it is fixed, or a
playbook entry marked fixed, plus the symptom absent from the latest completed
window. Otherwise it is `ongoing`. `harmless` comes only from the playbook.

A case-memory hit with none of the above is reported in the summary as "seen
before on <date>" and leaves `known` as `no`.

When an alert is known and ongoing, the debugger still runs the client-effect
sample (the table needs it) but does not re-derive the cause. `knownRef` is
shown on the card as plain text, not as a live link; the verified Logs link
stays the card's only live link. Owners are not looked up in this project.

### 6. Playbooks

Each playbook in `skills/investigate-alerts/references/` gains three short
sections the table depends on: **Client effect check** (what to sample and what
"affected" means for this alert), **Sustained check**, and **Known harmless
patterns**. Their existing Severity sections are removed, since the table now
owns severity; each playbook instead states its fixed `alertSeverity` when the
alert text carries none, and a **Known patterns** list with ids. The skill's workflow ends with "report the facts", not "assign
a priority".

Playbooks are where alert knowledge lives, and they are updated over time
(the owner's decision). How updates happen is the author's proposal: the
debugger stays read-only, so it suggests a change in the thread when it sees a
reason (for example a pattern seen three times that should become "known
harmless"), and a person edits the playbook file through a normal pull request.

### 7. Other paths (the author's call: all move to facts)

- `investigation_record` (extra issues in one reply) takes the same facts in
  place of a model-written `priority`; the stored case keeps the facts and the
  computed priority.
- Digest threads with several error categories produce one card for the
  category the table rates highest; the other categories are listed in the
  summary with their own computed levels.
- Plain-text replies that today print "Priority unknown" print the computed
  level or no priority line at all.
- Priority buttons are switched off on DEV. If they come back, a person's
  choice wins over a recompute and the "Why" line says who set it; the button
  token is out of scope here.

### 8. Testing

- Unit tests for `computePriority`: every rule row, the validation rules, and a
  policy file with reordered rules.
- A replay file with the live alerts seen so far (phone call notes, language
  detection timeouts, api-gateway errors, two conversation-avatar alerts): the
  facts a careful reader would report, and the priority the owner expects. The
  owner supplies the expected priorities.
- The skill's example envelope must parse in both plugins.

## Depends on (already in progress, not part of this design)

- Logs tool fixes: the tab-delimited error filter, `textContains`, `count`.
- Paging is off on the deployed host (it needs a store API that is missing);
  reads stop at 50 rows. The impact sample must work within that until fixed.
- The drafted playbooks.

## Left to the builder

- How the two plugins share `computePriority` and the policy file.
- Exact JSON shape of `priority-policy.json`.
- Whether V2 envelopes are rejected or mapped for one release.
- Wording of the "Why" line and its length limits.
- How the memory plugin's stored cases migrate from V2 fields.
