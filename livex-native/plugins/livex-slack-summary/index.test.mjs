import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const sdkHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "openclaw/plugin-sdk/plugin-entry") {
      return nextResolve(specifier, context);
    }
    return {
      url: "data:text/javascript,export%20const%20definePluginEntry%20%3D%20(entry)%20%3D%3E%20entry",
      shortCircuit: true,
    };
  },
});
const { default: entry } = await import("./index.ts").finally(() => sdkHook.deregister());
let render;
entry.register({
  on(name, callback) {
    assert.equal(name, "reply_payload_sending");
    assert.equal(render, undefined);
    render = callback;
  },
});
assert.equal(typeof render, "function");

const summary = {
  priority: "medium",
  provisional: true,
  impact: "An upstream timeout was recovered by the request retry.",
  nextAction: "Confirm whether later requests needed retries.",
  owner: "Unassigned",
  checkedWindow: "2026-01-21 12:20–12:25 UTC",
  evidenceUrl: "https://console.cloud.google.com/logs/query?window=short&level=error",
};
const evidence = "The complete report includes private correlation IDs and diagnostics.";
const mark = "LIVEX_ALERT_SUMMARY_V1";
const envelope = (fields, full = evidence) => `${mark}\n${JSON.stringify(fields)}\n\n${full}`;
const route = { replyToId: "1768996800.000001", replyToTag: true, replyToCurrent: false };
const event = {
  kind: "final",
  channel: "slack",
  sessionKey: "agent:debugger:slack:channel:c123:thread:1768996800.000001",
};

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
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Priority: Medium (provisional)" } },
          {
            type: "section",
            text: { type: "plain_text", text: `Impact: ${summary.impact}` },
          },
          {
            type: "section",
            text: {
              type: "plain_text",
              text: `Next action: ${summary.nextAction}\nOwner: Unassigned`,
            },
          },
          {
            type: "section",
            text: { type: "plain_text", text: `Evidence: ${summary.checkedWindow}` },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "<https://console.cloud.google.com/logs/query?window=short&amp;level=error|View evidence>",
                verbatim: true,
              },
              { type: "plain_text", text: "Mention this bot in the thread for full evidence." },
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
    /private correlation IDs|full-evidence|LIVEX_ALERT_SUMMARY_V1/u,
  );
});

test("renders model fields as literal text and supports unknown priority without a link", () => {
  const impact = "Model text with <!channel> and *formatting* stays literal.";
  const text = envelope({ ...summary, priority: "unknown", impact, evidenceUrl: null }).replaceAll(
    "\n",
    "\r\n",
  );
  const { blocks } = render({ ...event, payload: { text } }).payload.channelData.slack;
  assert.equal(blocks[0].text.text, "Priority: Unknown");
  assert.deepEqual(blocks[1].text, { type: "plain_text", text: `Impact: ${impact}` });
  assert.deepEqual(blocks[4].elements, [
    { type: "plain_text", text: "Mention this bot in the thread for full evidence." },
  ]);
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
    envelope({ ...summary, impact: "x".repeat(241) }),
    envelope({ ...summary, impact: "x".repeat(4097) }),
    envelope({ ...summary, nextAction: "Line one\nLine two" }),
    envelope({ ...summary, impact: "Hidden\u0000control" }),
    envelope({ ...summary, owner: " " }),
    envelope({ ...summary, priority: "urgent" }),
    envelope({ ...summary, provisional: "yes" }),
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
    const { blocks } = render({ ...event, payload: { ...route, text: envelope({ ...summary, evidenceUrl }) } })
      .payload.channelData.slack;
    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks[4].elements, [
      { type: "plain_text", text: "Mention this bot in the thread for full evidence." },
    ]);
  }
  const allowed = render({
    ...event,
    payload: { ...route, text: envelope({ ...summary, evidenceUrl: "https://console.cloud.google.com:443/logs/query" }) },
  }).payload.channelData.slack.blocks[4].elements[0];
  assert.match(allowed.text, /^<https:\/\/console\.cloud\.google\.com\/logs\/query\|View evidence>$/u);
});

test("renders the card for team-qualified Slack thread sessions", () => {
  const sessions = [
    "agent:debugger:slack:channel:team:t0123abc:channel:c123:thread:1768996800.000001",
    "agent:debugger:slack:channel:c123:thread:1768996800.000001",
  ];
  for (const sessionKey of sessions) {
    const result = render({ ...event, sessionKey, payload: { ...route, text: envelope(summary) } });
    assert.equal(result.payload.channelData.slack.blocks[0].type, "header", sessionKey);
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
