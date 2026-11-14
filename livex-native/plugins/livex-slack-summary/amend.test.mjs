import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_TS, CHANNEL, SENDER, SESSION, THREAD, baseConfig, buttonsOf, envelope, fakeClick, load, flat, postCard, recordEvidence, recordOutcomes, linked as summary } from "./test-helpers.mjs";

const OTHER_THREAD = "1768990000.000009";
const OTHER_SESSION = `agent:debugger:slack:channel:${CHANNEL.toLowerCase()}:thread:${OTHER_THREAD}`;
const ctx = (sessionKey = SESSION) => ({ sessionKey, agentId: "debugger", toolName: "message" });
const edit = (params = {}) => ({
  toolName: "message",
  params: { action: "edit", target: `channel:${CHANNEL}`, messageId: CARD_TS, message: envelope({ ...summary, sampleAffected: 4 }), ...params },
});
const guard = (loaded, event, sessionKey) => loaded.hooks.get("before_tool_call")(event, ctx(sessionKey));
const blocked = (result) => result?.block === true && typeof result.blockReason === "string" && result.blockReason.length > 0;

function ready(config = baseConfig) {
  const loaded = load(config);
  recordEvidence(loaded, { entryUrls: [summary.evidenceUrl] });
  recordOutcomes(loaded);
  postCard(loaded);
  return loaded;
}

// The six card sections of an amendment in display order: Title from the presentation,
// the rest from the colour-bar attachment.
const sectionsOf = (params) => [
  params.presentation.blocks[0].text,
  ...params.livexAttachments[0].blocks.slice(0, 5).map((block) => block.text.text),
];
const buttonsBlockOf = (params) => params.presentation.blocks[1];

test("an amendment of the agent's own card in its own thread is allowed and re-rendered as the same card", () => {
  const loaded = ready();
  const result = guard(loaded, edit());
  assert.equal(result.block, undefined);
  const { params } = result;
  assert.equal(params.messageId, CARD_TS);
  assert.equal(params.message_id, CARD_TS);
  assert.equal(params.message, "\u{1F534} checkout-api upstream timeouts");
  const { presentation } = params;
  assert.equal("title" in presentation, false);
  // Title and buttons are the presentation; the rest is the coloured attachment (the first post's split).
  assert.deepEqual(presentation.blocks.map((block) => block.type), ["text", "buttons"]);
  assert.deepEqual(sectionsOf(params), [
    "*Title:* checkout-api upstream timeouts",
    "*Priority:* \u{1F534} High",
    "*Why:* clients affected (4 of 5 sampled) · known: no · alert: error · users affected: several customers or most of the sample",
    `*Next action:* ${summary.nextAction} (Owner: Unassigned)`,
    `*Summary:* ${summary.summary}`,
    "*Evidence:* <https://console.cloud.google.com/logs/query?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22|Logs> · Checked window: 2026-01-21 12:20–12:25 UTC",
  ]);
  assert.equal(params.livexAttachments.length, 1);
  assert.equal(params.livexAttachments[0].color, "#D92D20");
  assert.deepEqual(params.livexAttachments[0].blocks.at(-1), { type: "context", elements: [{ type: "plain_text", text: "Mention this bot in the thread for full evidence." }] });
  // The tool's own `attachments` param is the media pipeline and is never set.
  assert.equal("attachments" in params, false);
  // The full report, JSON line and marker never reach the edit.
  assert.doesNotMatch(JSON.stringify(params), /private IDs|LIVEX_ALERT_SUMMARY_V/u);
  const buttons = buttonsBlockOf(params).buttons;
  assert.deepEqual(buttons.map((button) => button.label), ["Medium", "Low", "Resolved"]);
  for (const button of buttons) {
    assert.equal(button.action.type, "callback");
    assert.match(button.action.value, /^livex-priority:(medium|low|resolved):i[A-Za-z0-9_-]+$/u);
  }
});

test("an amended card's buttons are accepted by the click handler (same value as the stock callback path)", async () => {
  const loaded = ready();
  const { params } = guard(loaded, edit());
  const resolve = buttonsBlockOf(params).buttons.find((button) => button.label === "Resolved");
  // The stock renderer sends a callback button's value unchanged as the interaction data.
  const click = fakeClick({ value: resolve.action.value });
  await loaded.interactive.handler(click.ctx);
  assert.equal(flat(click.calls.edits[0])[1].text.text, "*Priority:* \u{1F7E2} Resolved · was High");
  assert.deepEqual(click.calls.replies, []);
});

test("model text in an amendment is inert: no mentions, links, channel refs or emphasis", () => {
  const loaded = ready();
  const body = "Ping <!channel> and <@U123> or <https://evil.example|click> & more.";
  const first = sectionsOf(guard(loaded, edit({ message: envelope({ ...summary, summary: body }) })).params);
  assert.equal(first[4], "*Summary:* Ping &lt;!channel&gt; and &lt;@\u200DU123&gt; or &lt;https:\u200D//evil.example|click&gt; &amp; more.");

  const hostile = "see https://evil.example/login @here #general *bold*";
  const more = `${hostile} _it_ ~s~ \`c\``;
  const hostileParams = guard(loaded, edit({ message: envelope({ ...summary, title: hostile, summary: more, nextAction: hostile, owner: "@here", checkedWindow: hostile }) })).params;
  const sections = sectionsOf(hostileParams);
  const modelBlocks = [0, 3, 4, 5].map((index) => ({ text: sections[index] }));
  // Strip the card's own label and the evidence link, leaving only model text.
  const text = modelBlocks
    .map((block) => block.text.replace(/^\*[^:]+:\* /u, "").replace(/<https:\/\/console\.cloud\.google\.com[^>]*>/u, ""))
    .join("\n");
  assert.equal(hostileParams.presentation.blocks[0].type, "text");
  assert.doesNotMatch(text, /:\/\//u);
  for (const char of ["@", "#", "*", "_", "~", "`"]) {
    [...text].forEach((c, i) => c === char && assert.equal(text[i + 1], "\u200D", `${char} at ${i}`));
  }
  // The only live link is the evidence field's allowlisted one.
  const links = JSON.stringify(hostileParams).match(/<https?:[^>]*>/gu) ?? [];
  assert.deepEqual(links.map((link) => link.replace(/\|.*$/u, "")), ["<https://console.cloud.google.com/logs/query?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22"]);
  const dropped = guard(loaded, edit({ message: envelope({ ...summary, evidenceUrl: "https://evil.example/login" }) })).params;
  assert.doesNotMatch(JSON.stringify(dropped), /<https?:/u);
  // The fallback text is neutralized too.
  assert.equal(guard(loaded, edit({ message: envelope({ ...summary, title: "@here <!channel>" }) })).params.message, "\u{1F7E1} @\u200Dhere &lt;!channel&gt;");
});

test("an amendment carries no buttons when buttons are not configured, but is still allowed", () => {
  const loaded = ready(null);
  const result = guard(loaded, edit());
  assert.deepEqual(result.params.presentation.blocks.map((block) => block.type), ["text"]);
  assert.equal(result.params.livexAttachments[0].blocks.length, 6);
});

test("message target forms for the current channel are accepted", () => {
  const loaded = ready();
  for (const target of [CHANNEL, `channel:${CHANNEL}`, `team:T0TEAM1:channel:${CHANNEL}`, `slack:channel:${CHANNEL}`]) {
    for (const key of ["target", "to", "channelId"]) {
      const { target: _drop, ...rest } = edit().params;
      const result = guard(loaded, { toolName: "message", params: { ...rest, [key]: target } });
      assert.equal(result.block, undefined, `${key}=${target}`);
    }
  }
  const aliased = { ...edit().params, messageId: undefined, message_id: CARD_TS };
  assert.equal(guard(loaded, { toolName: "message", params: aliased }).params.messageId, CARD_TS);
});

test("an amendment of a foreign message ts is blocked", () => {
  const loaded = ready();
  for (const messageId of ["1768996800.000001", "1768996999.999999", "1768996900.000101", THREAD]) {
    assert.ok(blocked(guard(loaded, edit({ messageId }))), messageId);
  }
});

test("an amendment from another thread cannot touch this thread's card, and vice versa", () => {
  const loaded = ready();
  assert.ok(blocked(guard(loaded, edit(), OTHER_SESSION)));
  // The other thread's own card is amendable there only.
  postCard(loaded, { sessionKey: OTHER_SESSION, ts: "1768990100.000200" });
  assert.equal(guard(loaded, edit({ messageId: "1768990100.000200" }), OTHER_SESSION).block, undefined);
  assert.ok(blocked(guard(loaded, edit({ messageId: "1768990100.000200" }), SESSION)));
  // Same thread timestamp in another channel is a different session.
  const elsewhere = `agent:debugger:slack:channel:c0other9:thread:${THREAD}`;
  assert.ok(blocked(guard(loaded, edit(), elsewhere)));
});

test("a target outside this thread's channel is blocked even for the right ts", () => {
  const loaded = ready();
  const cases = [
    { target: "channel:C0OTHER99" },
    { target: `channel:${CHANNEL}`, to: "channel:C0OTHER99" },
    { target: undefined, to: undefined, channelId: undefined },
    { target: "user:U0ALLOWED" },
    { target: `${CHANNEL}x` },
    { targets: [`channel:${CHANNEL}`] },
    { channel: "discord" },
    { target: 42 },
  ];
  for (const override of cases) {
    assert.ok(blocked(guard(loaded, edit(override))), JSON.stringify(override));
  }
});

test("a message id that is missing, malformed, conflicting or not a string is blocked", () => {
  const loaded = ready();
  const cases = [
    { messageId: undefined },
    { messageId: "" },
    { messageId: "not-a-ts" },
    { messageId: 1768996900.0001 },
    { messageId: CARD_TS, message_id: "1768996900.000999" },
    { messageId: [CARD_TS] },
  ];
  for (const override of cases) {
    assert.ok(blocked(guard(loaded, edit(override))), JSON.stringify(override));
  }
});

test("a non-card message from this bot in this thread is blocked", () => {
  const loaded = ready();
  const send = (event) => loaded.hooks.get("message_sent")({ to: `channel:${CHANNEL}`, success: true, sessionKey: SESSION, ...event }, { sessionKey: SESSION });
  // An ordinary text reply, the invalid-summary notice, and a failed post are never cards.
  send({ messageId: "1768997000.000001", content: "Plain answer from the thread." });
  loaded.hooks.get("reply_payload_sending")(
    { kind: "final", channel: "slack", sessionKey: SESSION, payload: { text: `LIVEX_ALERT_SUMMARY_V3\n{bad}\n\nfull` } },
    {},
  );
  send({ messageId: "1768997000.000002", content: "Could not format the investigation summary. Mention this bot in the thread for full evidence." });
  send({ messageId: "1768997000.000003", content: "", success: false });
  for (const messageId of ["1768997000.000001", "1768997000.000002", "1768997000.000003"]) {
    assert.ok(blocked(guard(loaded, edit({ messageId }))), messageId);
  }
  // A plain reply posted while a card is still unconfirmed does not steal the card's slot.
  const fresh = load();
  fresh.hooks.get("reply_payload_sending")({ kind: "final", channel: "slack", sessionKey: SESSION, payload: { text: envelope() } }, {});
  fresh.hooks.get("message_sent")({ to: "x", success: true, messageId: "1768997100.000001", content: "ordinary reply", sessionKey: SESSION }, {});
  fresh.hooks.get("message_sent")({ to: "x", success: true, messageId: "1768997100.000002", content: "", sessionKey: SESSION }, {});
  assert.ok(blocked(guard(fresh, edit({ messageId: "1768997100.000001" }))));
  assert.equal(guard(fresh, edit({ messageId: "1768997100.000002" })).block, undefined);
});

test("a ts that predates the thread root, an unsolicited message_sent, and a stale pending card are not recorded", () => {
  const loaded = load();
  const sent = (messageId, sessionKey = SESSION) => loaded.hooks.get("message_sent")({ to: "x", success: true, messageId, content: "", sessionKey }, {});
  sent("1768996900.000100"); // no card was rendered: nothing to confirm
  assert.ok(blocked(guard(loaded, edit())));
  loaded.hooks.get("reply_payload_sending")({ kind: "final", channel: "slack", sessionKey: SESSION, payload: { text: envelope() } }, {});
  sent("1768996799.999999"); // before the thread root
  assert.ok(blocked(guard(loaded, edit({ messageId: "1768996799.999999" }))));
  sent("1768996900.000100", OTHER_SESSION); // wrong session consumes nothing
  sent(CARD_TS);
  assert.equal(guard(loaded, edit()).block, undefined);
});

test("an amendment must use the same summary envelope; anything else is blocked with a reason", () => {
  const loaded = ready();
  const cases = [
    undefined,
    "",
    "Updated: now High priority.",
    `${envelope().split("\n\n")[0]}`,
    `Here you go\n${envelope()}`,
    "```\n" + envelope() + "\n```",
    envelope({ ...summary, priority: "urgent" }),
    envelope({ ...summary, priority: "high" }),
    envelope({ ...summary, sampleAffected: 6 }),
    envelope({ ...summary, resolved: "yes" }),
    envelope({ ...summary, evidenceUrl: 42 }),
    envelope({ ...summary, extra: 1 }),
    `LIVEX_ALERT_SUMMARY_V1\n${JSON.stringify(summary)}\n\nfull`,
    `LIVEX_ALERT_SUMMARY_V2\n${JSON.stringify(summary)}\n\nfull`,
    `LIVEX_ALERT_SUMMARY_V3\n{not json}\n\nfull`,
    ` \nLIVEX_ALERT_SUMMARY_V3\n${JSON.stringify(summary)}\n\nfull`.replace(" \n", "x\n"),
  ];
  for (const message of cases) {
    const result = guard(loaded, edit({ message }));
    assert.ok(blocked(result), String(message));
    assert.match(result.blockReason, /summary envelope|messageId|target/u);
  }
  // The agent can mark the report resolved through the envelope.
  const resolved = guard(loaded, edit({ message: envelope({ ...summary, resolved: true }) }));
  assert.equal(sectionsOf(resolved.params)[1], "*Priority:* \u{1F7E2} Resolved · was Medium");
  assert.equal(resolved.params.message, "\u{1F7E2} checkout-api upstream timeouts");
});

const NEW_CARD = "Do not retry the edit. End your reply with a new LIVEX_ALERT_SUMMARY_V3 summary and the full report instead; the Gateway posts it as a new card.";

test("an unknown card (or a restarted gateway) is refused with the new-card fallback, no message content", () => {
  // A fresh instance: the thread's earlier card is not in its memory, as after a restart.
  const restarted = load();
  const result = guard(restarted, edit());
  assert.ok(blocked(result));
  assert.equal(
    result.blockReason,
    "This message cannot be amended (it is not a summary card this Gateway posted in this thread, or the Gateway restarted since). " + NEW_CARD,
  );
  const loaded = ready();
  assert.equal(guard(loaded, edit({ messageId: "1768997777.000001" })).blockReason, result.blockReason);
});

test("refusals where a new card is the fallback say so; an invalid envelope names what is wrong, never its content", () => {
  const loaded = ready();
  const missing = { ...summary };
  delete missing.nextAction;
  const cases = [
    [edit({ message: "Updated: now High priority." }), /no summary envelope/u],
    [edit({ message: envelope(missing) }), /missing field nextAction/u],
    [edit({ message: envelope({ ...summary, sampleAffected: 6 }) }), /invalid field sampleAffected/u],
    [edit({ messageId: "not-a-ts" }), /messageId/u],
    [edit({ target: "channel:C0OTHER99" }), /target/u],
  ];
  for (const [event, why] of cases) {
    const result = guard(loaded, event);
    assert.ok(blocked(result));
    assert.match(result.blockReason, why);
    assert.ok(result.blockReason.endsWith(NEW_CARD), result.blockReason);
    assert.doesNotMatch(result.blockReason, /Updated: now|private IDs|checkout-api|\{/u);
  }
  const envelopeReason = guard(loaded, edit({ message: envelope(missing) })).blockReason;
  assert.match(envelopeReason, /valid summary envelope/u);
});

test("a person's button choice outranks the agent's later re-assessment of the same card", async () => {
  const loaded = ready();
  const first = guard(loaded, edit({ message: envelope({ ...summary, sampleAffected: 4 }) }));
  const click = fakeClick({ value: buttonsBlockOf(first.params).buttons.find((b) => b.label === "Low").action.value });
  await loaded.interactive.handler(click.ctx);
  assert.equal(flat(click.calls.edits[0])[1].text.text, "*Priority:* ⚪ Low");
  // The agent's new facts compute High; the person's Low stands.
  const second = guard(loaded, edit({ message: envelope({ ...summary, sampleAffected: 5, summary: "New evidence: errors continue." }) }));
  assert.equal(sectionsOf(second.params)[1], "*Priority:* ⚪ Low");
  assert.equal(sectionsOf(second.params)[4], "*Summary:* New evidence: errors continue.");
});

test("everything that is not a debugger-thread message edit is left alone", () => {
  const loaded = ready();
  const hook = loaded.hooks.get("before_tool_call");
  assert.equal(hook({ toolName: "livex_gcp_logs_read", params: { action: "edit" } }, ctx()), undefined);
  for (const action of ["read", "reactions", "send", "delete", undefined, 5]) {
    assert.equal(hook({ toolName: "message", params: { action } }, ctx()), undefined, String(action));
  }
  // Another agent's session is not this plugin's to police.
  assert.equal(hook(edit(), { sessionKey: "agent:oncall:slack:channel:c0alerts1:thread:1768996800.000001", agentId: "oncall" }), undefined);
  assert.equal(hook(edit(), { agentId: "main" }), undefined);
  // The debugger without a thread-bound session cannot be verified, so it is refused.
  assert.ok(blocked(hook(edit(), { agentId: "debugger" })));
  assert.ok(blocked(hook(edit(), { sessionKey: `agent:debugger:slack:channel:${CHANNEL.toLowerCase()}`, agentId: "debugger" })));
  assert.ok(blocked(hook(edit(), { sessionKey: `agent:debugger:slack:direct:u0allowed:thread:${THREAD}`, agentId: "debugger" })));
  assert.ok(blocked(hook({ toolName: "message", params: { ...edit().params, action: " EDIT " } }, ctx("agent:debugger:main"))));
});

test("the amendment allow-list is bounded", () => {
  const loaded = load();
  for (let n = 0; n < 40; n += 1) {
    postCard(loaded, { ts: `1768997${String(n).padStart(3, "0")}.000001` });
  }
  assert.ok(blocked(guard(loaded, edit({ messageId: "1768997000.000001" }))));
  assert.equal(guard(loaded, edit({ messageId: "1768997039.000001" })).block, undefined);
});

test("hooks never throw on malformed events, hostile objects, or a failing host", async () => {
  const loaded = ready();
  const trap = {
    get toolName() {
      throw new Error("boom");
    },
  };
  const hostile = new Proxy({}, { get: () => { throw new Error("proxy"); }, has: () => { throw new Error("proxy"); }, ownKeys: () => { throw new Error("proxy"); } });
  const circular = { toolName: "message", params: { action: "edit" } };
  circular.params.self = circular;
  const inputs = [undefined, null, 0, "text", [], {}, trap, hostile, circular, { toolName: "message", params: hostile }, { toolName: "message", params: { action: "edit", messageId: hostile } }];
  for (const [name, hook] of loaded.hooks) {
    for (const input of inputs) {
      for (const context of [undefined, null, {}, hostile, ctx()]) {
        assert.doesNotThrow(() => hook(input, context), `${name}`);
      }
    }
  }
  // Markers on a throwing payload fail closed instead of leaking the envelope.
  const poisoned = { kind: "final", channel: "slack", sessionKey: SESSION, payload: { get text() { throw new Error("x"); } } };
  assert.doesNotThrow(() => loaded.hooks.get("reply_payload_sending")(poisoned, {}));
  assert.equal(guard(loaded, { toolName: "message", params: hostile }) === undefined || blocked(guard(loaded, { toolName: "message", params: hostile })), true);
  // The click handler absorbs hostile contexts as well.
  for (const input of [undefined, null, hostile, { senderId: SENDER, interaction: hostile }]) {
    await assert.doesNotReject(async () => loaded.interactive.handler(input));
  }
});

test("a failed card send forgets its pending entry, so a later empty message is not a card", () => {
  const loaded = load();
  const render = (runId) => loaded.hooks.get("reply_payload_sending")({ kind: "final", channel: "slack", sessionKey: SESSION, runId, payload: { text: envelope() } }, {});
  const sent = (event) => loaded.hooks.get("message_sent")({ to: "x", content: "", sessionKey: SESSION, ...event }, {});
  render("run-1");
  sent({ success: false, error: "slack down" });
  sent({ success: true, messageId: "1768997200.000001" });
  assert.ok(blocked(guard(loaded, edit({ messageId: "1768997200.000001" }))));
  // A confirmation from another run cannot claim the card; its own run can.
  render("run-2");
  sent({ success: true, messageId: "1768997200.000002", runId: "run-9" });
  assert.ok(blocked(guard(loaded, edit({ messageId: "1768997200.000002" }))));
  sent({ success: true, messageId: "1768997200.000003", runId: "run-2" });
  assert.equal(guard(loaded, edit({ messageId: "1768997200.000003" })).block, undefined);
  // Without a run id on either side matching still works (covered by postCard elsewhere).
});

test("the pending map is bounded across sessions and prunes expired entries on insert", () => {
  const loaded = load();
  const render = (sessionKey) => loaded.hooks.get("reply_payload_sending")({ kind: "final", channel: "slack", sessionKey, payload: { text: envelope() } }, {});
  const session = (n) => `agent:debugger:slack:channel:c${String(n).padStart(8, "0")}:thread:1768996800.000001`;
  for (let n = 0; n < 600; n += 1) render(session(n));
  const sent = (n) => loaded.hooks.get("message_sent")({ to: "x", content: "", success: true, messageId: "1768997300.000001", sessionKey: session(n) }, {});
  // The oldest sessions were evicted (500 kept); the newest still confirm.
  const amend = (n) => guard(loaded, edit({ target: `channel:C${String(n).padStart(8, "0")}`, messageId: "1768997300.000001" }), session(n));
  sent(0);
  assert.ok(blocked(amend(0)));
  sent(599);
  assert.equal(amend(599).block, undefined);
});

// ------------------------------------------------ livexAttachments is the guard's alone

const STRIP = { params: { livexAttachments: undefined } };
const forgedAttachments = [{ color: "#000000", blocks: [{ type: "section", text: { type: "mrkdwn", text: "forged" } }] }];

test("any agent outside a debugger session has livexAttachments stripped, whatever the action", () => {
  const loaded = ready();
  const hook = loaded.hooks.get("before_tool_call");
  const others = [
    { sessionKey: "agent:main:slack:channel:c0alerts1:thread:1768996800.000001", agentId: "main" },
    { sessionKey: "agent:main:main", agentId: "main" },
    { agentId: "main" },
    { agentId: "debugger" },
    {},
  ];
  for (const toolCtx of others) {
    for (const action of ["edit", "send", "react", "Edit ", undefined]) {
      const result = hook(
        { toolName: "message", params: { ...(action ? { action } : {}), target: `channel:${CHANNEL}`, messageId: CARD_TS, livexAttachments: forgedAttachments } },
        toolCtx,
      );
      // The debugger without a session keeps its own refusal for an edit.
      if (toolCtx.agentId === "debugger" && !toolCtx.sessionKey && action?.trim().toLowerCase() === "edit") {
        assert.equal(blocked(result), true);
        continue;
      }
      assert.deepEqual(result, STRIP, `${JSON.stringify(toolCtx)} ${action}`);
      // The shallow param merge then leaves no array for the patched edit to forward.
      assert.equal(Array.isArray({ livexAttachments: forgedAttachments, ...result.params }.livexAttachments), false);
    }
  }
  // Nothing to strip, nothing returned; another tool is never touched.
  assert.equal(hook({ toolName: "message", params: { action: "send" } }, others[0]), undefined);
  assert.equal(hook({ toolName: "message", params: { action: "edit", livexAttachments: undefined } }, others[0]), undefined);
  assert.equal(hook({ toolName: "exec", params: { livexAttachments: forgedAttachments } }, others[0]), undefined);
});

test("a debugger card edit always overwrites a model-supplied livexAttachments", () => {
  const loaded = ready();
  const { params } = guard(loaded, edit({ livexAttachments: forgedAttachments }));
  assert.notDeepEqual(params.livexAttachments, forgedAttachments);
  assert.equal(params.livexAttachments[0].blocks.at(-1).type, "context");
  assert.doesNotMatch(JSON.stringify(params), /forged/u);
  // A debugger edit that is refused never reaches the patched edit path.
  assert.equal(blocked(guard(loaded, edit({ messageId: "1768997777.000001", livexAttachments: forgedAttachments }))), true);
});

test("an amendment is recomputed from its facts with this thread's logs reads", () => {
  // No read in this thread (e.g. a new process): the effect is not verified, so 0 affected is not "no".
  const unread = load();
  postCard(unread);
  const before = sectionsOf(guard(unread, edit({ message: envelope({ ...summary, sampleAffected: 0 }) })).params);
  assert.equal(before[1], "*Priority:* \u{1F7E1} Medium");
  assert.match(before[2], /^\*Why:\* client effect not verified \(0 of 5 sampled\)/u);
  // With three outcome reads the same facts are "no client effect" and Low; more affected is High.
  const loaded = ready();
  const low = sectionsOf(guard(loaded, edit({ message: envelope({ ...summary, sampleAffected: 0 }) })).params);
  assert.equal(low[1], "*Priority:* ⚪ Low");
  const high = guard(loaded, edit());
  assert.equal(sectionsOf(high.params)[1], "*Priority:* \u{1F534} High");
  assert.equal(high.params.livexAttachments[0].color, "#D92D20");
});

test("a successful amendment publishes the recomputed result to the priority registry", () => {
  const registry = () => globalThis[Symbol.for("livex.priority-engine.v1")].results.get(SESSION);
  const loaded = ready();
  assert.deepEqual(registry().primary, { signature: summary.signature, priority: "medium", ruleId: "live-narrow" });
  const result = loaded.hooks.get("before_tool_call")({ ...edit(), runId: "run-amend" }, ctx());
  assert.equal(result.block, undefined);
  assert.equal(registry().runId, "run-amend");
  assert.deepEqual(registry().primary, { signature: summary.signature, priority: "high", ruleId: "live-broad" });
  // A refused amendment leaves the registry as it was.
  guard(loaded, edit({ messageId: "1768997777.000001", message: envelope({ ...summary, sampleAffected: 0 }) }));
  assert.equal(registry().primary.priority, "high");
});
