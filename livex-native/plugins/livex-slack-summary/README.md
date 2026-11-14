# livex-slack-summary

Turns the Debugger's marked final reply (`LIVEX_ALERT_SUMMARY_V2`, one JSON line, a blank
line, the full report) into a compact Slack card, and keeps that card correctable. Any other
marker version (including V1) renders the short notice instead.

- **Envelope.** The JSON line has exactly these keys: `title`, `signature`, `priority`,
  `provisional`, `summary`, `nextAction`, `owner`, `checkedWindow`, plus optional `resolved` and
  `evidenceUrl`. Unknown keys are invalid. `signature` (`service | operation | error class`) is
  not shown; another plugin reads it to record the investigation.
- **Card.** The layout of PR #1: the Title is the only top-level section (the priority buttons
  follow it, so they are always visible); Priority (emoji, written priority, `(provisional)`, or
  `Resolved · was High`), Next action with owner, Summary, Evidence (a `Logs` link and the checked
  window) and the "mention this bot" hint are one Slack attachment with a colour bar (high and
  critical `#D92D20`, medium `#D99A00`, resolved `#2E8B57`, otherwise `#9CA3AF`). The reply
  payload sets `channelData.slack.blocks` and `channelData.slack.attachments`; a button click
  passes `blocks` and `attachments` to `respond.editMessage`. Stock Slack outbound drops
  attachments, so this needs `deploy/patch-slack-attachments.mjs` (applied by the image build;
  without it the colour-barred part of the card is not sent). The message's fallback text is
  `<emoji> <title>`. Anything malformed becomes a short notice; the JSON and the full report
  never reach Slack.
- **Evidence link.** Accepted only on `console.cloud.google.com`, path `/logs/query`, and only
  when the `query` parameter contains `insertId=` or both `timestamp>=` and `timestamp<=`. Any
  other link (including a generic `resource.type=...` query) is dropped and the card shows
  "No verified evidence link"; the card still posts. A link longer than 1600 characters
  (`&` counted as `&amp;`) is dropped the same way, as is any other link that cannot be
  verified; only a malformed envelope rejects the card. The log tool omits a
  `logsExplorerUrl` over the same limit (`MAX_EVIDENCE_URL` here, `MAX_CARD_EVIDENCE_URL`
  there). A replaced card, and a failure in any hook, logs one `livex-slack-summary:` line
  with a fixed reason (for example `invalid field owner`, `unknown key`, `bad layout`) and
  no content.
- **Priority buttons.** With `allowedSenderId` and `allowedChannelId` configured, the card
  carries High, Medium, Low and Resolved buttons. Only the configured sender can use them; the
  card is edited in place (`respond.editMessage`). A refused or invalid click never alters the
  card: the handler makes no `respond.reply` or `respond.followUp` call (they post to Slack's
  `response_url` and replace the whole message), it returns `{ handled: true }` and logs a warning
  without token contents. Without both keys the card has no buttons.
  Each button value carries the card state plus an HMAC-SHA256 tag bound to the card's channel
  and thread, so a forged, tampered or replayed value is refused. A card whose state does not fit
  a button value (1900 characters) is posted without buttons, with a logged warning.
- **Signing key.** A 32-byte key in `<stateDir>/plugins/livex-slack-summary/button-key`
  (`api.runtime.state.resolveStateDir()`, else `OPENCLAW_STATE_DIR`), directory 0700, file 0600,
  created atomically (`wx`) and read synchronously at `register()`. Every plugin instance and every
  restart therefore signs and verifies with the same key. With no state dir, or a corrupt file
  (never overwritten), the buttons are disabled and a warning is logged.
- **Amendments.** The `before_tool_call` guard lets the debugger's `message` tool `edit` only
  a card this plugin rendered in the current thread (confirmed by `message_sent`), only with
  the same envelope, and re-renders it through the stock presentation renderer with the same
  fields in the same order (model text is entity-escaped and neutralized). The tool takes only
  `message` and a portable `presentation`, so the guard splits the card like the first post: the
  Title and the buttons are the presentation (top-level blocks) and the colour-barred part is
  passed as raw blocks in a separate `livexAttachments` param (the tool's own `attachments` is
  the media pipeline). The patched edit path sanitizes it and sends it to `chat.update`; an edit
  without it sends `attachments: []`, so no stale bar survives. Any other target is
  blocked with a reason. The record is in memory, so a gateway restart ends amendments of older
  cards.

Wiring (fragment, Slack interactivity, agent instructions, limits, live smoke):
[`WIRING-step4.md`](WIRING-step4.md). Tests: `npm test`.
