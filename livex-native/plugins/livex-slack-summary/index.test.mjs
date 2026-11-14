import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

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

const summary = {
  title: "checkout-api upstream timeouts",
  signature: "checkout-api | create order | upstream timeout",
  priority: "medium",
  provisional: true,
  summary: "An upstream timeout was recovered by the request retry.",
  nextAction: "Confirm whether later requests needed retries.",
  owner: "Unassigned",
  checkedWindow: "2026-01-21 12:20–12:25 UTC",
  evidenceUrl: "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=insertId%3D%22abc123%22",
};
const evidence = "The complete report includes private correlation IDs and diagnostics.";
const mark = "LIVEX_ALERT_SUMMARY_V2";
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
      result: { content: [], details: { project: "livex-copilot-prd", entries: [{ entryUrl: summary.evidenceUrl }] } },
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
  const text = envelope(summary);
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
              "*Priority:* \u{1F7E1} Medium (provisional)",
              `*Next action:* ${summary.nextAction} (Owner: Unassigned)`,
              `*Summary:* ${summary.summary}`,
              "*Evidence:* Logs · Checked window: 2026-01-21 12:20–12:25 UTC",
            ].join("\n"),
            blocks: [
              mrkdwn("*Priority:* \u{1F7E1} Medium (provisional)"),
              mrkdwn(`*Next action:* ${summary.nextAction} (Owner: Unassigned)`),
              mrkdwn(`*Summary:* ${summary.summary}`),
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

test("renders model fields as literal text and supports unknown priority without a link", () => {
  const body = "Model text with <!channel> and *formatting* and @here stays literal.";
  const text = envelope({ ...summary, priority: "unknown", summary: body, evidenceUrl: null }).replaceAll(
    "\n",
    "\r\n",
  );
  const blocks = flat(render({ ...event, payload: { text } }).payload.channelData.slack);
  assert.equal(blocks[1].text.text, "*Priority:* \u26AA Unknown");
  assert.equal(
    blocks[3].text.text,
    "*Summary:* Model text with &lt;!channel&gt; and *\u200Dformatting*\u200D and @\u200Dhere stays literal.",
  );
  assert.equal(blocks[3].text.verbatim, true);
  assert.equal(blocks[4].text.text, `*Evidence:* No verified evidence link · Checked window: ${summary.checkedWindow}`);
  // An absent evidenceUrl is the same as null.
  const { evidenceUrl: _drop, ...noUrl } = summary;
  assert.equal(
    flat(render({ ...event, payload: { text: envelope(noUrl) } }).payload.channelData.slack)[4].text.text.startsWith(
      "*Evidence:* No verified evidence link",
    ),
    true,
  );
});

test("malformed marked output cannot pass through JSON, diagnostics, or unsafe URLs", () => {
  const cases = [
    mark,
    "Here is the summary.\n" + envelope(summary),
    "Here is the summary.\r\n  " + envelope(summary).replaceAll("\n", "\r\n"),
    "```json\n" + envelope(summary) + "\n```",
    `${mark}\n{invalid json}\n\n${evidence}`,
    `${mark}\n${JSON.stringify(summary)}\n${evidence}`,
    envelope(summary, " "),
    envelope({ ...summary, additional: "extra key" }),
    envelope({ ...summary, checkedWindow: undefined }),
    envelope({ ...summary, title: undefined }),
    envelope({ ...summary, signature: undefined }),
    envelope({ ...summary, title: "x".repeat(121) }),
    envelope({ ...summary, signature: "x".repeat(161) }),
    envelope({ ...summary, summary: "x".repeat(601) }),
    envelope({ ...summary, nextAction: "x".repeat(301) }),
    envelope({ ...summary, owner: "x".repeat(81) }),
    envelope({ ...summary, checkedWindow: "x".repeat(81) }),
    envelope({ ...summary, summary: "x".repeat(4097) }),
    envelope({ ...summary, impact: "the retired V1 field" }),
    `LIVEX_ALERT_SUMMARY_V1\n${JSON.stringify(summary)}\n\n${evidence}`,
    `LIVEX_ALERT_SUMMARY_V3\n${JSON.stringify(summary)}\n\n${evidence}`,
    envelope({ ...summary, nextAction: "Line one\nLine two" }),
    envelope({ ...summary, title: " " }),
    envelope({ ...summary, summary: "Hidden\u0000control" }),
    envelope({ ...summary, owner: " " }),
    envelope({ ...summary, priority: "urgent" }),
    envelope({ ...summary, provisional: "yes" }),
    envelope({ ...summary, resolved: "true" }),
    envelope({ ...summary, resolved: 1 }),
    envelope({ ...summary, resolved: null }),
    envelope({ ...summary, evidenceUrl: "http://console.example.test/logs" }),
    envelope({ ...summary, evidenceUrl: "https://user:password@console.example.test/logs" }),
    envelope({ ...summary, evidenceUrl: "https://console.cloud.google.com/logs|unsafe>" }),
    envelope({ ...summary, evidenceUrl: `https://console.cloud.google.com/${"x".repeat(1600)}` }),
    envelope({ ...summary, evidenceUrl: `https://console.cloud.google.com/?x${"&x".repeat(400)}` }),
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

test("drops evidence links outside the Logs Explorer host but still posts the card", () => {
  const dropped = [
    "https://console.cloud.google.com.evil.example/logs",
    "https://evil.example/console.cloud.google.com",
    "https://console.example.test/logs",
    "https://console.cloud.google.com:8443/logs",
    "https://sub.console.cloud.google.com/logs",
  ];
  for (const evidenceUrl of dropped) {
    const slack = render({ ...event, payload: { ...route, text: envelope({ ...summary, evidenceUrl }) } })
      .payload.channelData.slack;
    const blocks = flat(slack);
    assert.equal(blocks.length, 6);
    assert.match(blocks[4].text.text, /^\*Evidence:\* No verified evidence link · Checked window: /u);
    assert.doesNotMatch(JSON.stringify(blocks), /<https?:/u);
  }
  const allowed = flat(render({
    ...event,
    payload: { ...route, text: envelope({ ...summary, evidenceUrl: `${EVIDENCE_LINK.replaceAll("&amp;", "&").replace("https://console.cloud.google.com", "https://console.cloud.google.com:443")}` }) },
  }).payload.channelData.slack)[4];
  assert.match(allowed.text.text, /^\*Evidence:\* <https:\/\/console\.cloud\.google\.com\/logs\/query\?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22\|Logs> · Checked window: /u);
});

test("renders the card for team-qualified Slack thread sessions", () => {
  const sessions = [
    "agent:debugger:slack:channel:team:t0123abc:channel:c123:thread:1768996800.000001",
    "agent:debugger:slack:channel:c123:thread:1768996800.000001",
  ];
  for (const sessionKey of sessions) {
    recordLink(sessionKey);
    const result = render({ ...event, sessionKey, payload: { ...route, text: envelope(summary) } });
    assert.equal(result.payload.channelData.slack.blocks[0].text.text, "*Title:* checkout-api upstream timeouts", sessionKey);
  }
  for (const sessionKey of [
    "agent:oncall:slack:channel:team:t0123abc:channel:c123:thread:1768996800.000001",
    "agent:debugger:slack:channel:team:t0123abc:channel:c123",
    "agent:debugger:slack:channel:team:t0123abc:user:u123:thread:1768996800.000001",
  ]) {
    assert.equal(render({ ...event, sessionKey, payload: { text: envelope(summary) } }), undefined, sessionKey);
  }
});

test("leaves other channels, agents, unmarked replies, and progress alone", () => {
  const marked = { text: envelope(summary) };
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

test("priority marker and written word render for every priority", () => {
  const expected = {
    critical: "*Priority:* \u{1F534} Critical",
    high: "*Priority:* \u{1F534} High",
    medium: "*Priority:* \u{1F7E1} Medium",
    low: "*Priority:* \u26AA Low",
    unknown: "*Priority:* \u26AA Unknown",
  };
  for (const [priority, text] of Object.entries(expected)) {
    assert.equal(priorityOf({ ...summary, priority, provisional: false }), text);
  }
  assert.equal(
    priorityOf({ ...summary, priority: "high", provisional: true }),
    "*Priority:* \u{1F534} High (provisional)",
  );
});

test("resolved badge overrides the marker, keeps the written priority, and is opt-in", () => {
  assert.equal(
    priorityOf({ ...summary, priority: "high", provisional: false, resolved: true }),
    "*Priority:* \u{1F7E2} Resolved \u00B7 was High",
  );
  assert.equal(
    priorityOf({ ...summary, priority: "medium", resolved: true }),
    "*Priority:* \u{1F7E2} Resolved \u00B7 was Medium (provisional)",
  );
  for (const resolved of [false, undefined]) {
    const text = priorityOf({ ...summary, priority: "high", provisional: false, resolved });
    assert.equal(text, "*Priority:* \u{1F534} High");
    assert.doesNotMatch(text, /Resolved/u);
  }
});

test("a card has no header or plain-text section, only mrkdwn sections in the PR 1 order", () => {
  const blocks = flat(render({ ...event, payload: { text: envelope({ ...summary, resolved: true }) } }).payload.channelData.slack);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["section", "section", "section", "section", "section", "context"],
  );
  assert.deepEqual(
    blocks.slice(0, 5).map((block) => block.text.text.match(/^\*([^:]+):\*/u)[1]),
    ["Title", "Priority", "Next action", "Summary", "Evidence"],
  );
  assert.ok(blocks.slice(0, 5).every((block) => block.text.type === "mrkdwn" && block.text.verbatim === true));
});
