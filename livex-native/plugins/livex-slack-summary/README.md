# livex-slack-summary

Turns the Debugger's marked final reply (`LIVEX_ALERT_SUMMARY_V2`, one JSON line, a blank
line, the full report) into a compact Slack card, and keeps that card correctable. Any other
marker version (including V1) renders the short notice instead.

- **Envelope.** The JSON line has exactly these keys: `title`, `signature`, `priority`,
  `provisional`, `summary`, `nextAction`, `owner`, `checkedWindow`, plus optional `resolved` and
  `evidenceUrl`. Unknown keys are invalid. `signature` (`service | operation | error class`) is
  not shown; another plugin reads it to record the investigation.
- **Card.** mrkdwn sections in order: Title, Priority (emoji, written priority, `(provisional)`,
  or `Resolved · was High`), Next action with owner, Summary, Evidence (a `Logs` link and the
  checked window), then the "mention this bot" hint and the buttons. The message's fallback text
  is `<emoji> <title>`. Anything malformed becomes a short notice; the JSON and the full report
  never reach Slack.
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
  fields in the same order (model text is entity-escaped and neutralized). Any other target is
  blocked with a reason. The record is in memory, so a gateway restart ends amendments of older
  cards.

Wiring (fragment, Slack interactivity, agent instructions, limits, live smoke):
[`WIRING-step4.md`](WIRING-step4.md). Tests: `npm test`.
