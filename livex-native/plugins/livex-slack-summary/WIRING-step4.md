# Wiring proposal for step 4 (priority buttons and report amendments)

For the coordinator. Nothing below is applied: this plugin's own files are the only
edits made. Paths are relative to `livex-native/`. The diffs are written against the
current working tree, which already carries another worker's uncommitted edits to the
fragment (the `livex-investigations-lite` entry), so re-anchor hunks if they drift.

Source citations are `origin/main` at `9721116c77a` unless noted. The test VM pins
OpenClaw and `@openclaw/slack` 2026.10.5 (`deploy/versions.env`); the cited files were
spot-checked at `d18c1dcf0c5` (package.json version 2026.10.5) and the same code is
there (`interactive-dispatch.ts:73` `editMessage`, `blocks-render.ts:113-115` callback
target, `message-action-dispatch.ts:218` edit, `hook-runner-global.ts:36` fail-closed
`before_tool_call`). The release tarball itself could not be inspected here, so the
live smoke test in section 6 is the real confirmation.

## 0. What is and is not feasible on stock

| Part | Status |
| --- | --- |
| (a) Buttons on the card (High / Medium / Low / Resolved), sender- and channel-gated, edited in place | Feasible, implemented. |
| (a) Click state survives | Feasible. State rides in the button value (deflated, base64url) with an HMAC tag bound to channel and thread, re-validated on click. The key is persisted via `openKeyedStoreV2` (namespace `hmac-key`); without the store a per-process key makes older cards fail closed after a restart. A card too large for a 2000-char value falls back to a bounded in-memory reference (lost on gateway restart; the click then says the controls expired). |
| (b) Agent amends its own card instead of posting a duplicate | Feasible, implemented, with a restriction below. |
| (b) Amendment is rendered by the identical code as the first reply | **Not byte-identical.** The `message` tool's Slack `edit` accepts only `message` text and a portable `presentation`, never raw blocks (`extensions/slack/src/message-action-dispatch.ts:218-257`; schema `src/agents/tools/message-tool-schema.ts:139-148,282-287`). The guard therefore renders the same card *fields* through the stock presentation renderer. Same headline, same four sections, same evidence link and same buttons; the differences are cosmetic (see "Residual differences"). Producing identical raw blocks would need a core patch or direct Slack API access from the plugin, so it was not done. |
| (b) Ownership record survives a gateway restart | **No.** The set of card timestamps lives in memory. After a restart the card cannot be amended (the guard blocks with a reason) and the agent must say so in text. A durable record would need `api.runtime.state.openKeyedStoreV2` (as `livex-investigations-lite` uses); not built to keep this step small. |
| A person's click is visible to the agent | **No.** A plugin handler's result is ignored for block actions (`interactions.block-actions.ts:544` returns only `matched && handled`; `systemEvent` is used only by the modal path, `docs/channels/slack/rich-messages.md:146-161`). Instead the plugin remembers the person's choice in memory and applies it to any later amendment of the same card (human choice outranks the agent). Lost on restart. |

## 1. How it works (facts the design relies on)

Priority buttons:

- `api.registerInteractiveHandler({ channel: "slack", namespace, handler })`
  (`src/plugins/plugin-api.types.ts:366`, `src/plugins/registry-registrars.ts:98`). The
  namespace must match `^[A-Za-z0-9._-]+$` and be unique per channel
  (`src/plugins/interactive-registry.ts:55-82`). This plugin uses `livex-priority`.
- A block-action's plugin data string is `<action_id>:<value>`, except `openclaw:callback_button*`
  and `openclaw:reply_*` ids, where it is just `<value>`
  (`extensions/slack/src/monitor/events/interactions.block-actions.ts:114-127`;
  ids `extensions/slack/src/reply-action-ids.ts:3-40`). The registry splits at the first
  `:` into namespace and payload (`src/plugins/interactive-registry.ts:39-51`). The plugin
  uses callback ids with value `livex-priority:<choice>:<state>`, so a button rendered
  from raw blocks (first card) and from a `presentation` callback button (amendment,
  `extensions/slack/src/blocks-render.ts:113-116,349-376`) reach the same handler.
  Reply ids (`openclaw:reply_button`) would NOT reach a plugin handler
  (`interactions.block-actions.ts:805-825`), so they must not be used.
- Unhandled clicks go to the agent as a system event
  (`interactions.block-actions.ts:843-848`); the handler always returns `{ handled: true }`
  so a refused or broken click never reaches the model.
- Handler context: `senderId`, `conversationId`, `interaction.{kind,payload,messageTs}`,
  `respond.{reply,editMessage}` (`extensions/slack/src/interactive-dispatch.ts:53-80`).
  `respond.reply` is ephemeral by default (`interactions.block-actions.ts:497-504`);
  `respond.editMessage` is `chat.update` on the clicked message
  (`interactions.block-actions.ts:211-224,536-541`).
- Stock already refuses clicks from a sender the Slack channel config does not admit
  (`authorizeSlackBlockAction`, `interactions.block-actions.ts:271-298,814-817`). The
  plugin adds its own exact check against `allowedSenderId` and the `allowedChannelId`
  gate, as `livex-gcp-readonly` does.
- First-card blocks are raw `channelData.slack.blocks` (`extensions/slack/src/outbound-adapter.ts:124-137`,
  validated only for shape by `extensions/slack/src/blocks-input.ts:13-41`), so an
  `actions` block with buttons is accepted. Slack's value cap is 2000
  (`extensions/slack/src/presentation.ts:6`).

Report amendments:

- `before_tool_call` receives `{ toolName, params }` and `ctx.sessionKey`
  (`src/plugins/hook-types.ts:569-590,545-567`) and may return `{ block, blockReason }` or
  `{ params }` (`src/plugins/hook-before-tool-call-result.ts:14-17`). A block becomes the
  tool result (`src/agents/agent-tools.before-tool-call.policy.ts:315-323`). Returned `params`
  are shallow-merged over the model's (`...policy.ts:374-381`,
  `src/agents/agent-tools.before-tool-call.approval.ts:81-90`), so the guard overwrites
  `messageId`, `message_id`, `message` and `presentation`. The runner fails closed when a
  `before_tool_call` handler throws (`src/plugins/hook-runner-global.ts:33-37`), and the
  plugin's handler never throws anyway (it returns a block).
- The edit action reads `messageId` (alias `message_id`), `message`, `presentation`, and the
  target from `channelId` or `to` (`message-action-dispatch.ts:94-101,218-257`). The tool
  requires an explicit `target`/`to`/`channelId` (`src/agents/tools/message-tool-explicit-target.ts:24-60`).
  The guard requires every supplied target to name the session's channel, rejects `targets[]`
  and a non-Slack `channel`, and requires `messageId` to be a ts the plugin recorded.
- The record: `reply_payload_sending` (`src/plugins/hook-types.ts:506-526`) renders the card and
  queues a pending entry for the session; `message_sent` (`src/plugins/hook-message.types.ts:187-199`,
  emitted at `src/channels/turn/lifecycle.ts:311-315`, `src/infra/outbound/message-sent-hook.ts:39-68`)
  carries `sessionKey`, `success` and `messageId` (the primary message id,
  `lifecycle.ts:210-216`). A confirmed message becomes a card only if a card is pending for
  that session, its content is empty or contains the card's own header, and its ts is later
  than the thread root. A plain reply or the invalid-summary notice never qualifies.
- Session keys are `agent:debugger:slack:channel:<id>:thread:<ts>` (lowercase id); the guard
  uppercases the id for comparison with Slack targets. Another thread or channel has another
  session key, so its card ts are never in this session's set.
- Hook flags: none. `before_tool_call`, `message_sent` and `reply_payload_sending` are not in
  the conversation-access list (`docs/plugins/hooks.md:125-130`), so no `hooks:` block is
  needed (unlike `livex-investigations-lite`, which uses `before_prompt_build`).
- The agent-level `message.actions.allow` list is the policy that exposes `edit` at all
  (`src/config/zod-schema.agent-runtime.ts:588-593`, enforced in
  `src/infra/outbound/outbound-policy.ts:98-121`). The Slack action gate `messages` (which also
  covers read/edit/delete) defaults to on (`extensions/slack/src/message-actions.ts:36`,
  `src/agents/tools/common.ts:77-87`); the existing `channels.slack.actions: { reactions: true }`
  does not disable it.

Residual differences between first card and amendment:

- First card: plain_text sections. Amendment: model fields are `context` blocks (stock renders
  them verbatim mrkdwn, `extensions/slack/src/blocks-render.ts:285`: no auto-links or mention
  parsing), entity-escaped, with `://`, `@`, `#`, `*`, `_`, `~` and backtick split by a
  zero-width joiner. The only live link is the allowlisted evidence link. Text is smaller and grey.
- First card: `context` block with a mrkdwn link element plus a plain_text hint. Amendment:
  one mrkdwn context line with the same link and hint.
- First card: nothing in the top-level fallback text. Amendment: the headline is the fallback
  text of the edit.

## 2. config/openclaw.fragment.json5

Two real changes (plugin entry config for the buttons; `edit` in the allow list). No `hooks`
flags, no `allowPromptInjection`. `${SLACK_SENDER_ID}` is the variable the other entries already use.

```diff
--- a/config/openclaw.fragment.json5
+++ b/config/openclaw.fragment.json5
@@ -46,7 +46,15 @@
         },
       },
       slack: { enabled: true },
-      "livex-slack-summary": { enabled: true },
+      "livex-slack-summary": {
+        enabled: true,
+        // Both are needed for the priority buttons; without them the card has no
+        // buttons. Report amendments (message action "edit") do not depend on them.
+        config: {
+          allowedChannelId: "*",
+          allowedSenderId: "${SLACK_SENDER_ID}",
+        },
+      },
       "livex-investigations-lite": {
         enabled: true,
         hooks: { allowConversationAccess: true, allowPromptInjection: true },
@@ -139,7 +147,7 @@
           profile: "full",
           // OpenClaw tool allowlist: governs OpenClaw-managed tools only (the two
           // LiveX evidence tools, the two investigation memory tools, plus
-          // read-only helpers). Codex's native shell is bounded by the read-only
+          // read-only helpers and the guarded summary-card amendment). Codex's native shell is bounded by the read-only
           // appServer sandbox above, not by this list.
           allow: [
             "read",
@@ -150,7 +158,10 @@
             "investigation_record",
             "investigation_lookup",
           ],
-          message: { actions: { allow: ["read", "reactions"] } },
+          // "edit" is only usable on this agent's own summary card in the current
+          // thread: the livex-slack-summary before_tool_call guard blocks every other
+          // edit (WIRING-step4.md). Without that plugin enabled, do not allow "edit".
+          message: { actions: { allow: ["read", "reactions", "edit"] } },
           // "deny"/"allowlist" fail Codex preflight
           // (extensions/codex/src/app-server/config-exec-policy.ts:93-103).
           // "auto" forces model-backed approval review. "ask" keeps the read-only
```

If `SLACK_SENDER_ID` is unresolved the plugin still loads: the card renders without buttons
and no click handler is registered (amendments still work, since they gate on the session).
If you would rather keep `allowedChannelId` narrow, use the alert channel's id; the buttons
then appear only in that channel.

`deploy/apply.mjs` needs no change: it merges the fragment into `openclaw.json` without
resolving variables and `livex-slack-summary` is already in `managedPluginIds`
(`deploy/apply.mjs:50`). `deploy/test_apply.mjs:174` only asserts `enabled === true`.
Optionally assert the new `config` keys and the `edit` action in `deploy/test_apply.mjs`.

## 3. Slack app: interactivity and scopes

- No new bot scope. `chat:write` already covers `chat.update` on the bot's own messages
  (`docs/channels/slack/manifest-and-scopes.md:58`), which both the click edit and the
  message-tool edit use. `channels:history`/`groups:history` already cover reading the thread.
- **Interactivity must be enabled on the Slack app.** The stock Socket Mode manifest in the
  docs (`manifest-and-scopes.md:17-103`) has no `settings.interactivity` block, and
  block-action clicks are only delivered when it is on. The Enterprise Grid manifest shows the
  setting as `"interactivity": { "is_enabled": true }` (`docs/channels/slack/enterprise-grid.md:67`).
  In Socket Mode there is no request URL to configure. Things to check on the existing app
  (api.slack.com/apps, the app, "Interactivity & Shortcuts"):
  1. The toggle is on. If it was already on for the PR #1 demo's buttons, nothing to do.
  2. `settings.interactivity.is_enabled: true` appears in the app manifest if you manage it as
     code; add it next to `socket_mode_enabled` if missing.
  3. The app token has `connections:write` (already required for Socket Mode).
  4. If the app runs in HTTP Request URL mode instead, `interactivity.request_url` must point
     at the same gateway endpoint as the events URL (`manifest-and-scopes.md:142-146`).
  Enabling interactivity is a Slack-side change; it should not need new scopes, but confirm in the app settings whether Slack asks for a re-install.
- Whether it is already on cannot be determined from this repository. A quick check from the
  gateway: click a button on a freshly posted card; with interactivity off Slack shows
  "This app is not configured to handle interactive responses" and the gateway logs nothing.

## 4. Debugger instructions

Instructions the agent needs: when to amend, how to find its card, what the final answer is
afterward, and that a person's button choice wins. `AGENTS.md` also loses its "only read and
reactions" sentence.

```diff
--- a/agents/debugger/AGENTS.md
+++ b/agents/debugger/AGENTS.md
@@ -168,10 +168,41 @@
 accepted ownership, deadlines and unarmed follow-up visible under its lifecycle
 rules. Assess priority and health independently of disposition.
 
-This agent's `message` tool exposes only `action=read` and `action=reactions`
-(read-back). Include the supported disposition as text in the normal reply.
-Preserve existing markers. Use the configured tools and identity.
+This agent's `message` tool exposes `action=read`, `action=reactions` (read-back)
+and a guarded `action=edit` for amending your own summary card (see "Amending
+your summary card"). Include the supported disposition as text in the normal
+reply. Preserve existing markers. Use the configured tools and identity.
 
+## Amending your summary card
+
+The summary card you posted in this thread can be corrected in place instead of
+posting a second card. Amend when new evidence in this same thread changes the
+card itself: the priority, the impact, the next action or owner, the checked
+window, or recovery (`resolved`). Do not amend for a plain answer, a status
+question, or a detail that belongs in ordinary thread text; answer those in
+the normal reply and leave the card alone.
+
+1. Find your card: `message` with `action=read`, using the alert's root timestamp
+   as `threadId`. Your card is the reply from this bot with a "Priority:" or
+   "Resolved" header. Use that reply's exact `ts` as `messageId`. If you cannot
+   identify it with certainty, do not edit; say so in the reply.
+2. Call `message` once with `action=edit`, `target` set to this thread's channel,
+   `messageId` set to that `ts`, and `message` set to the complete summary
+   envelope from `investigate-alerts` (marker line, one JSON line, a blank line,
+   the full report). Nothing else is accepted and the card is re-rendered from
+   those fields. The edit is refused for any message that is not your own card
+   in this thread.
+3. Never edit anyone else's message, an older thread's card, or a reply that is
+   not a card. If the edit is refused, do not retry with other arguments and do
+   not post a second card; explain in plain text.
+4. Your final answer for the turn is then one plain sentence saying what changed
+   on the card and why. Do not return a new envelope: that would post a duplicate card.
+
+A person can change the card's priority or mark it resolved with the card's
+buttons. Their choice outranks your re-assessment: after an amendment the card
+keeps the person's priority and resolved state. If you disagree, say so in
+ordinary text instead of fighting the card.
+
 ## Choosing the response
 
 Choose the response from the current human request. Answer status, handoff and
```

```diff
--- a/agents/debugger/skills/investigate-alerts/SKILL.md
+++ b/agents/debugger/skills/investigate-alerts/SKILL.md
@@ -232,6 +232,12 @@
   card fields. Keep identifiers, query diagnostics, secondary hypotheses and
   additional sources in the full report after the blank line. The Gateway sends
   the card and retains the authored report in this thread’s native session.
+- When new evidence in the same thread changes the card (priority, impact,
+  next action, owner, checked window, or recovery), amend your earlier card
+  with `message` `action=edit` and this same envelope in `message` instead of
+  returning a second envelope; see "Amending your summary card" in the agent
+  instructions. A reply that only answers a question keeps the card as is. After
+  a successful edit, the final answer is one plain sentence about what changed.
 - If asked for full evidence or an explicit detailed/table reply, return the
   requested report directly, without the envelope marker. Reuse this thread’s retained
   evidence and label its freshness. If history is unavailable, say so and
```

## 5. Behavior to expect (and what the agent cannot do)

- The agent can edit only a message that this plugin recorded as a card it rendered in this
  session's thread: not a human's message, not another agent's, not another thread's card, not
  an ordinary reply, not a message from before the last gateway restart. Every refusal returns
  a reason as the tool result.
- The edit content must be the same `LIVEX_ALERT_SUMMARY_V1` envelope; everything else is
  refused. The full report after the blank line is dropped, as in the first reply.
- Other `message` actions (`read`, `reactions`, ...) are untouched by the guard; they remain
  governed by `message.actions.allow`. Other agents' sessions are not touched at all. A
  debugger edit with no thread-bound session is refused.
- A button click changes the card's priority or resolved state. A priority click clears
  `provisional` and reopens a resolved card; Resolved keeps the priority ("Resolved · was High").
- The agent never sees clicks. Its guard keeps a person's priority/resolved state on later
  amendments until the gateway restarts.

## 6. Live smoke (the checks only a real Slack and gateway can answer)

1. Post an alert summary. The card shows the four buttons (High/Medium/Low/Resolved, minus a
   no-op one). Check the reply posted exactly once.
2. Click as the allowed user: the same message is edited in place. Click as another user in
   the same channel: ephemeral refusal, no edit. Click Resolved, then High: reopens.
3. Confirm `message_sent` carries the Slack ts as `messageId` for the card and the plugin
   recorded it: ask the agent to amend (new evidence). If the edit is blocked with "not one (or
   this gateway has restarted...)" although the card is fresh, `message_sent` is not delivering
   `sessionKey`/`messageId` for this Slack reply path and the record never fills. That is the
   single unverified link in the chain (it was read from source, not exercised).
4. Ask the agent to amend its card, then try to make it edit a human's message ts and a card in
   another thread: both must be refused with a reason.
5. Check the edited card's buttons still work (they use the same callback ids and values).
6. In a group-thread turn the message tool may rewrite `message` text for edits
   (`src/agents/tools/message-tool-group-thread.ts:104-109`); that only affects the fallback text,
   not the card blocks. Confirm the visible card is unchanged by it.
7. If `messages.groupChat.visibleReplies` or a "completion source reply" mode ever restricts the
   tool to `send` only (`src/agents/tools/message-tool-source-policy.ts:132-136`), `edit` is
   refused by stock, before this plugin. The fragment uses `automatic`, which is not that mode.

## 7. Tests

`node --test index.test.mjs interactive.test.mjs amend.test.mjs` from this plugin's directory
(also `npm test`). Rendering and validation behavior from before this step is covered
unchanged by `index.test.mjs`; the new files cover buttons, the sender and channel gates,
priority and Resolved re-renders, tampered and oversized values, the reference-store
fallback, allowed and blocked amendments, a human choice outranking a later amendment, and
that no hook throws.
