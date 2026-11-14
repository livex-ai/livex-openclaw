import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { INVALID_SUMMARY, colorOf } from "./core.mjs";
import { SESSION, cardOf, cardText, factsOf, linked, load, postCard, recordRead, summary } from "./test-helpers.mjs";

const sdkHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "openclaw/plugin-sdk/plugin-entry") {
      return nextResolve(specifier, context);
    }
    return {
      url:
        "data:text/javascript," +
        encodeURIComponent(
          "export const definePluginEntry = (entry) => entry; export const buildJsonPluginConfigSchema = (schema) => schema;",
        ),
      shortCircuit: true,
    };
  },
});
const { default: entry } = await import("./index.ts").finally(() => sdkHook.deregister());
// The plugin has no host logger here, so it falls back to console.warn: collect it.
const logged = [];
console.warn = (message) => void logged.push(String(message));
const hooks = new Map();
let interactive;
entry.register({
  // No plugin config: the cards render without buttons and no click handler is registered.
  pluginConfig: {},
  on(name, callback) {
    assert.equal(hooks.has(name), false);
    hooks.set(name, callback);
  },
  registerInteractiveHandler(registration) {
    interactive = registration;
  },
});
assert.deepEqual([...hooks.keys()].sort(), [
  "after_tool_call",
  "before_tool_call",
  "message_sent",
  "reply_payload_sending",
]);
assert.equal(interactive, undefined);
const render = hooks.get("reply_payload_sending");
assert.equal(typeof render, "function");

const evidence = "The complete report includes private correlation IDs and diagnostics.";
const mark = "LIVEX_ALERT_SUMMARY_V3";
const HINT = "Mention this bot in the thread for full evidence.";
const EVIDENCE_LINK = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22";
const flat = (slack) => [slack.blocks[0], ...slack.attachments[0].blocks, ...slack.blocks.slice(1)];
const mrkdwn = (text) => ({ type: "section", text: { type: "mrkdwn", text, verbatim: true } });
const envelope = (fields, full = evidence) => `${mark}\n${JSON.stringify(fields)}\n\n${full}`;
// The evidence link counts only when the log tool returned it in the same session.
const recordLink = (sessionKey) =>
  hooks.get("after_tool_call")(
    {
      toolName: "livex_gcp_logs_read",
      params: {},
      result: { content: [], details: { project: "livex-copilot-prd", entries: [{ entryUrl: linked.evidenceUrl }] } },
    },
    { toolName: "livex_gcp_logs_read", sessionKey },
  );
const route = { replyToId: "1768996800.000001", replyToTag: true, replyToCurrent: false };
const event = {
  kind: "final",
  channel: "slack",
  sessionKey: "agent:debugger:slack:channel:c123:thread:1768996800.000001",
};
recordLink(event.sessionKey);

test("registered hook emits only a compact card and preserves the original evidence and route", () => {
  const text = envelope(linked);
  const payload = Object.freeze({
    ...route,
    text,
    fallbackText: { text: evidence },
    mediaUrl: "https://console.cloud.google.com/full-evidence",
    channelData: { slack: { blocks: [{ type: "section", text: evidence }] } },
  });
  const result = render({ ...event, payload });
  assert.deepEqual(result.payload, {
    ...route,
    channelData: {
      slack: {
        // The Title alone is top-level (buttons would follow it); the rest is one coloured attachment.
        blocks: [mrkdwn("*Title:* checkout-api upstream timeouts")],
        attachments: [
          {
            color: "#D99A00",
            fallback: [
              "*Title:* checkout-api upstream timeouts",
              "*Priority:* \u{1F7E1} Medium",
              "*Why:* clients affected (1 of 5 sampled) · known: no · alert: error",
              `*Next action:* ${linked.nextAction} (Owner: Unassigned)`,
              `*Summary:* ${linked.summary}`,
              "*Evidence:* Logs · Checked window: 2026-01-21 12:20–12:25 UTC",
            ].join("\n"),
            blocks: [
              mrkdwn("*Priority:* \u{1F7E1} Medium"),
              mrkdwn("*Why:* clients affected (1 of 5 sampled) · known: no · alert: error"),
              mrkdwn(`*Next action:* ${linked.nextAction} (Owner: Unassigned)`),
              mrkdwn(`*Summary:* ${linked.summary}`),
              mrkdwn(`*Evidence:* <${EVIDENCE_LINK}|Logs> · Checked window: 2026-01-21 12:20–12:25 UTC`),
              { type: "context", elements: [{ type: "plain_text", text: HINT }] },
            ],
          },
        ],
      },
    },
  });
  assert.equal(payload.text, text);
  assert.ok(payload.text.endsWith(evidence));
  assert.doesNotMatch(
    JSON.stringify(result),
    /private correlation IDs|full-evidence|LIVEX_ALERT_SUMMARY_V/u,
  );
});

test("renders model fields as literal text and a computed low priority without a link", () => {
  const body = "Model text with <!channel> and *formatting* and @here stays literal.";
  const text = envelope({ ...linked, sampleAffected: 0, summary: body, evidenceUrl: null }).replaceAll(
    "\n",
    "\r\n",
  );
  const blocks = flat(render({ ...event, payload: { text } }).payload.channelData.slack);
  assert.equal(blocks[1].text.text, "*Priority:* \u26AA Low");
  assert.equal(blocks[2].text.text, "*Why:* no client effect found (5 sampled) · known: no · alert: error");
  assert.equal(
    blocks[4].text.text,
    "*Summary:* Model text with &lt;!channel&gt; and *\u200Dformatting*\u200D and @\u200Dhere stays literal.",
  );
  assert.equal(blocks[4].text.verbatim, true);
  assert.equal(blocks[5].text.text, `*Evidence:* No verified evidence link · Checked window: ${linked.checkedWindow}`);
  // An absent evidenceUrl is the same as null.
  const { evidenceUrl: _drop, ...noUrl } = linked;
  assert.equal(
    flat(render({ ...event, payload: { text: envelope(noUrl) } }).payload.channelData.slack)[5].text.text.startsWith(
      "*Evidence:* No verified evidence link",
    ),
    true,
  );
});

test("malformed marked output cannot pass through JSON, diagnostics, or unsafe URLs", () => {
  const cases = [
    mark,
    "Here is the summary.\n" + envelope(linked),
    "Here is the summary.\r\n  " + envelope(linked).replaceAll("\n", "\r\n"),
    "```json\n" + envelope(linked) + "\n```",
    `${mark}\n{invalid json}\n\n${evidence}`,
    `${mark}\n${JSON.stringify(linked)}\n${evidence}`,
    envelope(linked, " "),
    envelope({ ...linked, additional: "extra key" }),
    envelope({ ...linked, checkedWindow: undefined }),
    envelope({ ...linked, title: undefined }),
    envelope({ ...linked, signature: undefined }),
    envelope({ ...linked, title: "x".repeat(121) }),
    envelope({ ...linked, signature: "x".repeat(161) }),
    envelope({ ...linked, summary: "x".repeat(601) }),
    envelope({ ...linked, nextAction: "x".repeat(301) }),
    envelope({ ...linked, owner: "x".repeat(81) }),
    envelope({ ...linked, checkedWindow: "x".repeat(81) }),
    envelope({ ...linked, summary: "x".repeat(4097) }),
    envelope({ ...linked, impact: "the retired V1 field" }),
    `LIVEX_ALERT_SUMMARY_V1\n${JSON.stringify(linked)}\n\n${evidence}`,
    `LIVEX_ALERT_SUMMARY_V2\n${JSON.stringify(linked)}\n\n${evidence}`,
    `LIVEX_ALERT_SUMMARY_V4\n${JSON.stringify(linked)}\n\n${evidence}`,
    envelope({ ...linked, nextAction: "Line one\nLine two" }),
    envelope({ ...linked, title: " " }),
    envelope({ ...linked, summary: "Hidden\u0000control" }),
    envelope({ ...linked, owner: " " }),
    envelope({ ...linked, priority: "urgent" }),
    envelope({ ...linked, priority: "high" }),
    envelope({ ...linked, provisional: "yes" }),
    envelope({ ...linked, alertClass: "GKE errors" }),
    envelope({ ...linked, service: "x" }),
    envelope({ ...linked, alertSeverity: "critical" }),
    envelope({ ...linked, sustained: "yes" }),
    envelope({ ...linked, known: "maybe" }),
    envelope({ ...linked, scope: "all" }),
    envelope({ ...linked, traffic: "prod" }),
    envelope({ ...linked, clientEffectVerified: 1 }),
    envelope({ ...linked, sampleChecked: "5" }),
    envelope({ ...linked, sampleAffected: null }),
    envelope({ ...linked, knownRef: "" }),
    envelope({ ...linked, knownRef: "LX-1\nLX-2" }),
    envelope({ ...linked, knownRef: "x".repeat(201) }),
    envelope({ ...linked, traffic: undefined }),
    envelope({ ...linked, alternates: {} }),
    envelope({ ...linked, alternates: Array.from({ length: 5 }, () => ({ ...factsOf(linked), title: "t" })) }),
    envelope({ ...linked, alternates: [{ ...factsOf(linked) }] }),
    envelope({ ...linked, alternates: [{ ...factsOf(linked), title: "t", priority: "high" }] }),
    envelope({ ...linked, alternates: [{ ...factsOf(linked), title: "t", sampleAffected: 9 }] }),
    envelope({ ...linked, alternates: [{ title: "t", alertClass: "a-b" }] }),
    envelope({ ...linked, alternates: [null] }),
    envelope({ ...linked, resolved: "true" }),
    envelope({ ...linked, resolved: 1 }),
    envelope({ ...linked, resolved: null }),
    envelope({ ...linked, evidenceUrl: 42 }),
  ];
  for (const text of cases) {
    assert.deepEqual(render({ ...event, payload: { ...route, text, spokenText: evidence } }), {
      payload: {
        ...route,
        text: "Could not format the investigation summary. Mention this bot in the thread for full evidence.",
      },
    });
  }
});

test("an over-long evidence link is dropped and the card still posts", () => {
  const long = `https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=insertId%3D%22a%22${"%20OR%20insertId%3D%22b%22".repeat(80)}`;
  assert.ok(long.length > 2000);
  logged.length = 0;
  const slack = render({ ...event, payload: { ...route, text: envelope({ ...linked, evidenceUrl: long }) } })
    .payload.channelData.slack;
  assert.match(flat(slack)[5].text.text, /^\*Evidence:\* No verified evidence link · /u);
  assert.deepEqual(logged, []);
});

test("an invalid card logs one fixed reason line with no card content", () => {
  const cases = [
    [envelope({ ...linked, owner: "SECRET-OWNER".repeat(20) }), "invalid field owner"],
    [envelope({ ...linked, extra: "SECRET-KEY-VALUE" }), "unknown key"],
    [`${mark}\n${JSON.stringify(linked)}\nSECRET-BODY`, "bad layout"],
    [`${mark}\n{SECRET json\n\nSECRET-BODY`, "bad json"],
    [envelope({ ...linked, evidenceUrl: 42 }), "invalid field evidenceUrl"],
    [envelope({ ...linked, title: undefined }), "missing field title"],
    [envelope({ ...linked, known: "SECRET" }), "invalid field known"],
    [envelope({ ...linked, provisional: true }), "unknown key"],
    [envelope({ ...linked, alternates: [{ title: "SECRET" }] }), "invalid field alternates"],
  ];
  for (const [text, reason] of cases) {
    logged.length = 0;
    render({ ...event, payload: { ...route, text } });
    assert.deepEqual(logged, [`livex-slack-summary: summary card replaced by notice: ${reason}`]);
    assert.doesNotMatch(logged[0], /SECRET/u);
  }
});

test("drops evidence links outside the Logs Explorer host but still posts the card", () => {
  const dropped = [
    "https://console.cloud.google.com.evil.example/logs",
    "https://evil.example/console.cloud.google.com",
    "https://console.example.test/logs",
    "https://console.cloud.google.com:8443/logs",
    "https://sub.console.cloud.google.com/logs",
    "http://console.example.test/logs",
    "https://user:password@console.example.test/logs",
    "https://console.cloud.google.com/logs|unsafe>",
    `https://console.cloud.google.com/${"x".repeat(1600)}`,
    `https://console.cloud.google.com/?x${"&x".repeat(400)}`,
  ];
  for (const evidenceUrl of dropped) {
    const slack = render({ ...event, payload: { ...route, text: envelope({ ...linked, evidenceUrl }) } })
      .payload.channelData.slack;
    const blocks = flat(slack);
    assert.equal(blocks.length, 7);
    assert.match(blocks[5].text.text, /^\*Evidence:\* No verified evidence link · Checked window: /u);
    assert.doesNotMatch(JSON.stringify(blocks), /<https?:/u);
  }
  const allowed = flat(render({
    ...event,
    payload: { ...route, text: envelope({ ...linked, evidenceUrl: `${EVIDENCE_LINK.replaceAll("&amp;", "&").replace("https://console.cloud.google.com", "https://console.cloud.google.com:443")}` }) },
  }).payload.channelData.slack)[5];
  assert.match(allowed.text.text, /^\*Evidence:\* <https:\/\/console\.cloud\.google\.com\/logs\/query\?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22\|Logs> · Checked window: /u);
});

test("renders the card for team-qualified Slack thread sessions", () => {
  const sessions = [
    "agent:debugger:slack:channel:team:t0123abc:channel:c123:thread:1768996800.000001",
    "agent:debugger:slack:channel:c123:thread:1768996800.000001",
  ];
  for (const sessionKey of sessions) {
    recordLink(sessionKey);
    const result = render({ ...event, sessionKey, payload: { ...route, text: envelope(linked) } });
    assert.equal(result.payload.channelData.slack.blocks[0].text.text, "*Title:* checkout-api upstream timeouts", sessionKey);
  }
  for (const sessionKey of [
    "agent:oncall:slack:channel:team:t0123abc:channel:c123:thread:1768996800.000001",
    "agent:debugger:slack:channel:team:t0123abc:channel:c123",
    "agent:debugger:slack:channel:team:t0123abc:user:u123:thread:1768996800.000001",
  ]) {
    assert.equal(render({ ...event, sessionKey, payload: { text: envelope(linked) } }), undefined, sessionKey);
  }
});

test("leaves other channels, agents, unmarked replies, and progress alone", () => {
  const marked = { text: envelope(linked) };
  const unrelatedEvents = [
    { channel: "webchat", payload: marked },
    { sessionKey: "agent:oncall:slack:channel:c123:thread:1768996800.000001", payload: marked },
    { sessionKey: "agent:debugger:slack:channel:c123", payload: marked },
    { sessionKey: "agent:debugger:slack:direct:u123:thread:1768996800.000001", payload: marked },
    { sessionKey: undefined, payload: marked },
    { kind: "block", payload: marked },
    { kind: "tool", payload: marked },
    { payload: { ...marked, isStatusNotice: true } },
    { payload: { text: "Full evidence\n\nThe logs show a recovered upstream timeout." } },
  ];
  for (const unrelated of unrelatedEvents) {
    assert.equal(render({ ...event, ...unrelated }), undefined);
  }
});

const priorityOf = (fields) =>
  flat(render({ ...event, payload: { ...route, text: envelope(fields) } }).payload.channelData.slack)[1]
    .text.text;

test("priority marker and written word render for every computed priority", () => {
  // The c123 session has one recorded read: 3 of 5 affected is broad, 1 is narrow, 0 is no effect.
  const expected = [
    [3, "*Priority:* \u{1F534} High"],
    [1, "*Priority:* \u{1F7E1} Medium"],
    [0, "*Priority:* \u26AA Low"],
  ];
  for (const [sampleAffected, text] of expected) {
    assert.equal(priorityOf({ ...linked, sampleAffected }), text);
  }
  assert.doesNotMatch(priorityOf({ ...linked, sampleAffected: 3 }), /provisional|Unknown|Critical/u);
});

test("resolved badge overrides the marker, keeps the computed priority, and is opt-in", () => {
  assert.equal(
    priorityOf({ ...linked, sampleAffected: 3, resolved: true }),
    "*Priority:* \u{1F7E2} Resolved \u00B7 was High",
  );
  assert.equal(
    priorityOf({ ...linked, resolved: true }),
    "*Priority:* \u{1F7E2} Resolved \u00B7 was Medium",
  );
  for (const resolved of [false, undefined]) {
    const text = priorityOf({ ...linked, sampleAffected: 3, resolved });
    assert.equal(text, "*Priority:* \u{1F534} High");
    assert.doesNotMatch(text, /Resolved/u);
  }
});

test("a card has no header or plain-text section, only mrkdwn sections in the PR 1 order", () => {
  const blocks = flat(render({ ...event, payload: { text: envelope({ ...linked, resolved: true }) } }).payload.channelData.slack);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["section", "section", "section", "section", "section", "section", "context"],
  );
  assert.deepEqual(
    blocks.slice(0, 6).map((block) => block.text.text.match(/^\*([^:]+):\*/u)[1]),
    ["Title", "Priority", "Why", "Next action", "Summary", "Evidence"],
  );
  assert.ok(blocks.slice(0, 6).every((block) => block.text.type === "mrkdwn" && block.text.verbatim === true));
});

test("buttons: false posts cards without buttons and registers no click handler", async () => {
  const { readConfig } = await import("./core.mjs");
  assert.equal(readConfig({ allowedChannelId: "*", allowedSenderId: "U0ALLOWED", buttons: false }).buttons, false);
  assert.equal(readConfig({ allowedChannelId: "*", allowedSenderId: "U0ALLOWED" }).buttons, true);
  assert.equal(readConfig({ allowedChannelId: "*", allowedSenderId: "U0ALLOWED", buttons: true }).buttons, true);
});

test("a failing hook logs one fixed reason line and never the hostile content", () => {
  const hostile = () => ({
    get sessionKey() {
      throw new Error("SECRET-PAYLOAD");
    },
    get toolName() {
      throw new Error("SECRET-PAYLOAD");
    },
    get params() {
      throw new Error("SECRET-PAYLOAD");
    },
    get result() {
      throw new Error("SECRET-PAYLOAD");
    },
    get kind() {
      throw new Error("SECRET-PAYLOAD");
    },
  });
  const ctx = { get sessionKey() { throw new Error("SECRET-PAYLOAD"); } };
  logged.length = 0;
  hooks.get("message_sent")(hostile(), ctx);
  hooks.get("after_tool_call")(hostile(), ctx);
  const blocked = hooks.get("before_tool_call")(hostile(), ctx);
  assert.equal(blocked.block, true);
  assert.deepEqual(logged, [
    "livex-slack-summary: card confirmation not recorded: message_sent handler failed",
    "livex-slack-summary: evidence links not recorded: after_tool_call handler failed",
    "livex-slack-summary: amendment guard failed closed: before_tool_call handler failed",
  ]);
  assert.ok(!logged.join("\n").includes("SECRET"));
});

// ------------------------------------------------------------ computed priority (V3)

test("the card shows the computed priority and why", () => {
  const loaded = load();
  recordRead(loaded);
  const text = cardText(postCard(loaded));
  assert.match(text, /\*Priority:\* 🟡 Medium/u);
  assert.match(text, /\*Why:\* clients affected \(1 of 5 sampled\) · known: no · alert: error/u);
  assert.equal(colorOf(cardOf(postCard(loaded))), "#D99A00");
});

test("with no recorded read the effect is not verified and a user-facing alert is rated up", () => {
  const text = cardText(postCard(load()));
  assert.match(text, /\*Priority:\* 🟡 Medium/u);
  assert.match(text, /client effect not verified \(1 of 5 sampled\)/u);
});

test("a capped listing read does not block 'no effect'", () => {
  const loaded = load();
  recordRead(loaded, { truncated: true, truncationReasons: ["row-limit"] });
  const text = cardText(postCard(loaded, { fields: { ...summary, sampleAffected: 0 } }));
  assert.match(text, /no client effect found/u);
});

test("a capped id-scoped read turns 'no effect' into not verified", () => {
  const loaded = load();
  recordRead(loaded, { truncated: true }, SESSION, { conversationId: "c1" });
  const text = cardText(postCard(loaded, { fields: { ...summary, sampleAffected: 0 } }));
  assert.match(text, /client effect not verified \(0 of 5 sampled, a read was capped or failed\)/u);
});

test("impossible sample counts replace the card with the notice and log the reason", () => {
  for (const bad of [{ sampleAffected: 6 }, { sampleAffected: -1 }, { sampleChecked: 2.5 }, { sampleChecked: 501 }]) {
    const loaded = load();
    const out = postCard(loaded, { fields: { ...summary, ...bad } });
    assert.equal(out.payload.text, INVALID_SUMMARY);
    assert.match(loaded.warnings.at(-1), /summary card replaced by notice: invalid field sample(Affected|Checked)$/u);
  }
});

test("V2 envelopes and model-written priority are rejected", () => {
  const loaded = load();
  assert.equal(postCard(loaded, { marker: "LIVEX_ALERT_SUMMARY_V2" }).payload.text, INVALID_SUMMARY);
  assert.equal(postCard(loaded, { fields: { ...summary, priority: "high" } }).payload.text, INVALID_SUMMARY);
});

test("a known reference is shown as inert text and an unaccepted one counts as no", () => {
  const loaded = load();
  recordRead(loaded);
  const shown = cardText(postCard(loaded, { fields: { ...summary, known: "ongoing", knownRef: "LX-12525" } }));
  assert.match(shown, /known: ongoing \(LX-12525\)/u);
  const hostile = cardText(postCard(loaded, { fields: { ...summary, known: "fixed", knownRef: "<!channel> <https://evil.example|LX-1>" } }));
  assert.match(hostile, /known: no/u);
  assert.doesNotMatch(hostile, /<!channel>|<https:\/\/evil/u);
});

test("alternates: the highest-rated fact set becomes the card and the rest are listed", () => {
  const loaded = load();
  recordRead(loaded);
  const alt = { ...factsOf(summary), title: "avatar sessions silent", sampleAffected: 4 };
  const text = cardText(postCard(loaded, { fields: { ...summary, alternates: [alt] } }));
  assert.match(text, /\*Title:\* avatar sessions silent/u);
  assert.match(text, /\*Priority:\* 🔴 High/u);
  assert.match(text, /Also: checkout-api upstream timeouts — Medium/u);
});

test("the priority engine registry carries the result for the memory plugin", () => {
  const loaded = load();
  recordRead(loaded);
  postCard(loaded, { runId: "run-1" });
  const entry = globalThis[Symbol.for("livex.priority-engine.v1")].results.get(SESSION);
  assert.equal(entry.runId, "run-1");
  assert.deepEqual(entry.primary, { signature: summary.signature, priority: "medium", ruleId: "live-narrow" });
  assert.equal(entry.compute({ ...factsOf(summary), sampleAffected: 4 }).priority, "high");
});

test("alternates: a tie keeps the main fact set, and the Also line is inert plain text of at most 300 characters", () => {
  const loaded = load();
  recordRead(loaded);
  const tie = { ...factsOf(summary), title: "same level elsewhere" };
  const result = postCard(loaded, { fields: { ...summary, alternates: [tie] } });
  assert.match(cardText(result), /\*Title:\* checkout-api upstream timeouts/u);
  assert.match(cardText(result), /Also: same level elsewhere — Medium/u);
  const hostileTitle = `<!here> *x* https://evil.example ${"y".repeat(90)}`;
  const many = Array.from({ length: 4 }, (_, index) => ({ ...factsOf(summary), sampleAffected: 0, title: `${index} ${hostileTitle}`.slice(0, 120) }));
  const slack = postCard(loaded, { fields: { ...summary, alternates: many } }).payload.channelData.slack;
  const also = slack.attachments[0].blocks.at(-1);
  assert.equal(also.type, "context");
  assert.deepEqual(also.elements.map((element) => element.type), ["plain_text"]);
  assert.ok(also.elements[0].text.startsWith("Also: 0 &lt;!here&gt; *‍x*‍ https:‍//evil.example"));
  assert.ok(also.elements[0].text.length <= 300);
  assert.equal(cardOf({ payload: { channelData: { slack } } }).also.length, 4);
  // No alternates, no Also line.
  assert.equal(postCard(loaded).payload.channelData.slack.attachments[0].blocks.at(-1).elements[0].text, "Mention this bot in the thread for full evidence.");
});

test("the Why line shows recurring and an accepted Slack reference, cut to 300 characters", () => {
  const loaded = load();
  recordRead(loaded);
  // 200 characters; every "&" grows to "&amp;" when neutralized, so the line must be cut.
  const ref = `https://livex.slack.com/archives/C0ALERTS1/p1768996800000001?${"&x".repeat(69)}y`;
  assert.equal(ref.length, 200);
  const fields = { ...summary, sampleAffected: 0, sustained: true, known: "ongoing", knownRef: ref };
  const why = cardText(postCard(loaded, { fields })).split("\n").find((line) => line.startsWith("*Why:* "));
  assert.ok(why.startsWith("*Why:* no client effect found (5 sampled) · known: ongoing (https:‍//livex.slack.com"));
  assert.equal(why.length - "*Why:* ".length, 300);
  const short = cardText(postCard(loaded, { fields: { ...summary, sampleAffected: 0, sustained: true } }));
  assert.match(short, /\*Why:\* no client effect found \(5 sampled\) · known: no · alert: error, recurring/u);
  assert.match(short, /\*Priority:\* 🟡 Medium/u);
});

test("the registry is shared across plugin instances, pruned after 30 minutes and bounded", () => {
  const key = Symbol.for("livex.priority-engine.v1");
  const registry = globalThis[key];
  assert.ok(registry.results instanceof Map);
  let clock = 5_000_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const stale = "agent:debugger:slack:channel:c0stale1:thread:1768996800.000001";
    registry.results.set(stale, { runId: undefined, at: clock - 30 * 60_000 - 1, primary: {}, compute() {} });
    const other = load();
    postCard(other);
    // A second instance wrote into the same registry object and pruned the stale entry.
    assert.equal(globalThis[key], registry);
    assert.equal(registry.results.has(stale), false);
    assert.equal(registry.results.get(SESSION).primary.priority, "medium");
    // compute refuses facts it was not built for.
    assert.throws(() => registry.results.get(SESSION).compute({ ...factsOf(summary), scope: "everywhere" }), TypeError);
    for (let index = 0; index < 510; index += 1) {
      postCard(other, { sessionKey: `agent:debugger:slack:channel:c0bulk${index}:thread:1768996800.000001` });
    }
    assert.equal(registry.results.size, 500);
  } finally {
    Date.now = realNow;
  }
});

test("a configured policy file changes the computed priority; a bad one warns and uses the default", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DEFAULT_POLICY } = await import("./priority.mjs");
  const dir = mkdtempSync(join(tmpdir(), "livex-policy-"));
  const path = join(dir, "policy.json");
  const allLow = { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.map((rule) => ({ ...rule, priority: "low" })), raise: [] };
  writeFileSync(path, JSON.stringify(allLow));
  const custom = load({ priorityPolicyPath: path });
  recordRead(custom);
  assert.match(cardText(postCard(custom, { fields: { ...summary, sampleAffected: 4 } })), /\*Priority:\* ⚪ Low/u);
  assert.deepEqual(custom.warnings, []);
  const broken = load({ priorityPolicyPath: join(dir, "missing.json") });
  assert.deepEqual(broken.warnings, ["livex-slack-summary: priority policy could not be read or parsed; using the built-in default"]);
  recordRead(broken);
  assert.match(cardText(postCard(broken, { fields: { ...summary, sampleAffected: 4 } })), /\*Priority:\* 🔴 High/u);
});
