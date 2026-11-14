# livex-slack-summary

Turns the Debugger's marked final reply (`LIVEX_ALERT_SUMMARY_V1`, one JSON line, a blank
line, the full report) into a compact Slack card, and keeps that card correctable.

- **Card.** Header `Priority: High|Medium|Low|Unknown` (or `Resolved · was High`), impact,
  next action and owner, checked window, evidence link. Anything malformed becomes a short
  notice; the JSON and the full report never reach Slack.
- **Priority buttons.** With `allowedSenderId` and `allowedChannelId` configured, the card
  carries High, Medium, Low and Resolved buttons. Only the configured sender can use them; the
  card is edited in place. A forged, corrupt or expired value fails closed with an ephemeral
  notice. Without both keys the card has no buttons.
  Each button value carries the card state plus an HMAC-SHA256 tag bound to the card's channel
  and thread, so a forged value, a tampered value, or a real value replayed onto another
  thread or channel is refused. The key is a random 32-byte value persisted through the
  keyed store (`hmac-key`), so buttons survive a gateway restart; if that store is
  unavailable a per-process key is used and clicks on cards posted before a restart fail closed.
  The reply hook never waits for the key (a stalled store must not post the raw envelope): cards
  posted before the stored key loads are signed with the interim per-process key and fail closed
  on click after the switch. Other hooks and clicks wait at most 2 s for the key.
- **Amendments.** The `before_tool_call` guard lets the debugger's `message` tool `edit` only
  a card this plugin rendered in the current thread (confirmed by `message_sent`), only with
  the same envelope, and re-renders it as the same card (model text is shown as inert context blocks). Any other target is blocked with a
  reason. The record is in memory, so a gateway restart ends amendments of older cards.

Wiring (fragment, Slack interactivity, agent instructions, limits, live smoke):
[`WIRING-step4.md`](WIRING-step4.md). Tests: `npm test`.
