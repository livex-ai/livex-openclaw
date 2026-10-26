# Action ownership and case lifecycle

Use these rules for action tracking, each follow-up check, and case closure.
The existing authorized coordinator owns permitted follow-up coordination. The action owner owns the required
result. These instructions do not create a background process or grant new access.

## Check current decisions first

Before each check or save, read the latest thread decisions and current row state.
Respect the scope of a hold, wait or stop. Record its reason and release condition
only where a save is permitted. A queued check or expired date cannot release it.
Do not resume paused work or schedules. A changed condition must be confirmed;
only a release already authorized by the user permits work to continue.

If a known row is missing, removed or inaccessible, stop writes to that record.
Do not recreate it from cached state. Report the exact target, failed action,
reason and whether access was denied, pending or uncertain. A failed read does
not prove deletion or recovery. Keep independently permitted evidence; do not
bypass access or switch destinations. Recheck these guards before saving results
from a long-running check. Preserve human decisions made while that check ran.

## Confirm ownership and deadlines

For each action, record the required result, proposed owner and accepted owner.
Link the acceptance evidence. A tag, proposal or acknowledgment alone is not
acceptance of the action. If no owner accepts, keep the action visibly unowned.
Set an acceptance check time. If it passes without acceptance, report the gap to
the user through the current authorized reporting destination.

Record the original accepted commitment deadline separately from the next-check
time. Include the timezone for both. Keep an unknown commitment deadline unknown.
Choose the next check from urgency and the owner's commitment. A later check does
not move the original deadline. Keep missed commitments visibly overdue. Record
an agreed revised deadline and its evidence beside the original; do not erase it.

For reassignment, retain the accepted owner until the replacement accepts. If
the old owner is no longer responsible or available, mark the action unowned
while transfer is pending. The coordinator is not an invented action owner. Raise missed acceptance, overdue results or increased impact to the user.
External messages, paging and owner assignments still need authorization.

## Verify follow-up execution

A saved next-check time is not a scheduled check. Before saying follow-up is
armed, verify an existing authorized execution mechanism. Verify its live enabled
state, target, due-action capability and supported timing from actual read results
or an execution receipt. A saved ACTIVE flag, new-alert scanner or pending bot-
report check alone does not establish this capability.

Record the verified mechanism ID, evidence and expected check time or delay. Its
checks must include overdue items after a missed run. If execution is missing or
unverified, state `follow-up not armed` and the exact gap. Name the accepted manual
check owner and time only when verified. Otherwise report manual responsibility
as unassigned. An accepted action owner is not automatically a manual check owner.
Do not create, enable, resume or modify schedules, bots or credentials under this
skill. Do not claim a future wake-up from skill text alone.

At an authorized check, read new replies and results. Check owner acceptance,
progress, due dates and original-operation evidence. Update only material changes
under the main skill's save, deduplication and read-back rules. Keep the original
deadline when setting the next check. Report an overdue result or access blocker;
do not keep moving check dates to hide it. Do not repeat unchanged notifications.

## Alert disposition versus case state

The main skill's warning/check/question describes whether a selected alert needs
a new human action. A reviewed—no-new-action checkmark does not itself close a
case, resolve a formal incident, or prove technical recovery. An existing issue
can remain failing with accepted tracked work; keep that work, commitment and
follow-up visible. Verify ownership and covered follow-up before using that
reason. Missing ownership, overdue results, new impact or unarmed required checks
can create a new action. Use question when the evidence cannot classify the alert.
An unrelated discovered defect does not set the original alert's disposition.

## Close or reopen

Keep investigation completion, case disposition and technical health separate.
Technical recovery needs observed success for the original logical operation and
adequate follow-up coverage. Checks, quiet logs, maintenance, removal from end
users and a merged PR do not establish recovery. Do not replay customer operations
or send synthetic production requests to prove it without separate authorization.

Administrative closure needs an explicit authorized human decision and reason.
For an unsupported service, record the support/setup context and any verified
removal from end users. Keep the failed handoff or other original outcome unresolved
unless success is proved. Record `closed by decision`, not `recovered`. Keep
formal incident-state changes within the authorized incident process and current
schema. Record the disposition in summary/history if no matching property exists.

Before closure, keep missing tickets, lost data and failed jobs owned with a next
check and verified execution, or link their accepted follow-up. A verified manual
check assignment can cover that check. If follow-up remains unarmed or unassigned,
keep the case open unless an authorized human accepts that unresolved gap.
Alternatively, record the authorized human's explicit acceptance of the unresolved
customer outcome. Closure must not silently discard customer work. State what
evidence or changed condition will reopen the case.

Reopen an unresolved failure when the stated reopening condition is met. Do not
undo an administrative closure for the same old retry alone. New supported-user
exposure or new impact can require a new decision. After verified recovery, treat
a new failed operation as a new episode. Preserve the earlier recovery and link
the related history; matching error text does not prove the same cause.

Keep one row per verified workspace/channel/root. A new episode under the same
root uses that row's dated history. A new root gets a linked row only after a
complete missing-row check and no known removal. Deduplicate event copies by
source identity. Preserve distinct occurrences and each operation's outcome.
