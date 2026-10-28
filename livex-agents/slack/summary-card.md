# LiveX Reporting thread summary

The Slack final-delivery adapter can project a recognized LiveX Reporting report into a native summary. It uses the existing original thread, bot reply, update path and receipts. It does not change the alert or channel digest.

## Presentation

The colored attachment starts with a bold title, immediately followed by a small, muted native Context subtitle: “⚠️ Action required”, “✅ Reviewed—no new action” or “❓ Unclassified”. An existing qualified critical fact adds explicit “Critical” text, preserving the actual disposition. The subtitle stays inside the card. These fields follow:

1. Next action.
2. Impact.
3. Finding.
4. Uncertainty or Blocker, when explicitly supplied.
5. Evidence, with at most one View evidence link and supplied checked window, time zone and inspected revision.

Owner stays out of visual rows. The complete original report, including existing canonical fields, remains the top-level accessibility fallback and native history. The adapter does not replace the investigator's report contract.

Slack controls spacing, borders, wrapping and typography. Report cards have no decorative top-level divider; the complete report remains the top-level accessibility fallback. Both title and subtitle stay inside the colored attachment; no floating status label or invisible placeholder is used. This approximates the approved hierarchy; it does not promise custom pills, fixed columns or a colored blocker background. The left accent uses Slack's attachment color; no image or custom CSS is sent.

## Evidence and missing data

The existing report author owns verification of the Evidence destination. The projection accepts a single HTTPS destination from that field, rejects credential-bearing URLs and omits missing, unsafe or ambiguous links. It does not fetch or independently verify a URL, and never constructs a Gateway, Slack, Notion or cloud URL.

Missing Impact remains explicitly unestablished. Supplied severity and investigation-status wording stays in the complete canonical fallback; the compact visual label omits unknown/partial/status boilerplate. An absent title uses Investigation summary. A provisional priority, error count, warning icon or unverified critical claim is not a verified severity.

Supplied evidence notes retain their checked window, time zone and code revision. Missing date/window metadata is labeled as not stated. Relative dates such as today are labeled unresolved in the visual notes; the projection never guesses a date from the system clock. The original fallback remains unchanged.

The projection preserves supplied recovery uncertainty. Green means reviewed with no new action; it does not establish recovery.

## Critical color boundary

The pure renderer supports an already verified active-critical fact from an existing severity policy or an authorized human declaration. That fact takes precedence over acknowledgement, no-new-action disposition or partial investigation.

The current automatic LiveX final-report path has no authoritative active-critical input and does not supply this option. Consequently, automatic delivery withholds red and shows the compact disposition label. The canonical report's severity and status text remains unchanged in the full fallback. Synthetic qualified-critical coverage proves only the renderer's color precedence; it does not establish a live critical-provenance handoff. Wiring such a source requires a separate approved change. Raw report text cannot enable the qualified-critical option.

Other colors are amber for action required, green for reviewed/no-new-action and gray for unclassified. Every color is accompanied by explicit text.

## Complete-text fallback

The pure projection declines oversized text, conflicting or repeated fields, unrecognized fields and unsupported report shapes. Existing delivery then carries the complete report instead of silently truncating material facts or dropping distinct findings.

The card fallback must fit both the resolved account limit and the existing 4,000-byte preview-edit boundary. No report is shortened to force it into a card.

## Unverified edits and source protection

The existing preview finalizer reads back an uncertain summary edit. If it cannot verify the exact message, thread, fallback, blocks and attachment, delivery retains the bot preview without claiming a final receipt or sending a duplicate. Later recognized summaries in the same turn are held, and the existing runtime error output identifies the unverified edit. This adds no background retry or persistent cross-turn retry system.

A preview handle that points at the original alert is never edited or cleared. The report uses the existing ordinary thread-reply path instead.

## Development and activation

Validation uses synthetic reports and mocked Slack boundaries. No live Slack message, investigation, customer operation or Gateway restart is required for development.

The implementation remains in its isolated source checkout until separately reviewed activation. Do not edit the running checkout, copy credentials or change models, permissions, escalation, reactions, skills, schedules or case persistence. Cron stays paused. Selecting a reviewed deployment revision and starting or restarting Gateway require separate approval.

References:

- [Slack secondary attachment color and nested blocks](https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments/).
- [Slack message text and accessibility fallback](https://docs.slack.dev/reference/methods/chat.postMessage/).
- [Slack section block limits](https://docs.slack.dev/reference/block-kit/blocks/section-block/).

## Formatting ownership

The `livex-oncall-reports` plugin owns both current report projections. Its trusted `agentProfiles` configuration selects the agent's schema and renderer. Shared Slack code consumes prepared text/blocks, validates fallback consistency and owns previews, native edits, threading and receipts. The catalog delivery owner remains unchanged. See `livex-agents/plugins/livex-oncall-reports/README.md` for configuration and local verification.
