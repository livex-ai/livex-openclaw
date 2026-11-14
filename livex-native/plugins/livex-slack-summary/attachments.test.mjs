import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { classifyEnvelope, decodeState, encodeState, readEvidenceHref, renderBlocks } from "./core.mjs";
import { createLogsTool } from "../livex-gcp-readonly/core.mjs";
import { CARD_TS, CHANNEL, PROJECT, SENDER, SESSION, THREAD, baseConfig, buttonsOf, envelope, fakeClick, flat, load, postCard, readStats, recordEvidence, recordRead, linked as summary } from "./test-helpers.mjs";

const slackOf = (result) => result.payload.channelData.slack;
const pick = (slack, label) => buttonsOf(slack.blocks).find((button) => button.text.text === label).value;
const VERIFIED = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=insertId%3D%22abc123%22";

test("the card is a Title block plus buttons at top level and one coloured attachment", () => {
  const slack = slackOf(postCard(load()));
  assert.deepEqual(slack.blocks.map((block) => block.type), ["section", "actions"]);
  assert.equal(slack.blocks[0].text.text, "*Title:* checkout-api upstream timeouts");
  assert.equal(slack.attachments.length, 1);
  const [attachment] = slack.attachments;
  // Only the keys the patched Slack package forwards.
  assert.deepEqual(Object.keys(attachment).sort(), ["blocks", "color", "fallback"]);
  assert.match(attachment.color, /^#[0-9A-F]{6}$/u);
  assert.deepEqual(
    attachment.blocks.map((block) => block.type),
    ["section", "section", "section", "section", "section", "context"],
  );
  assert.deepEqual(
    attachment.blocks.slice(0, 5).map((block) => block.text.text.match(/^\*([^:]+):\*/u)[1]),
    ["Priority", "Why", "Next action", "Summary", "Evidence"],
  );
  assert.ok(attachment.blocks.length <= 10);
  // Priority keeps its emoji in the attachment.
  assert.equal(attachment.blocks[0].text.text, "*Priority:* \u{1F7E1} Medium");
  assert.equal(attachment.fallback.includes("<http"), false);
  assert.match(attachment.fallback, /^\*Title:\* .*\n\*Priority:\* /u);
  assert.deepEqual(buttonsOf(slack.blocks).map((button) => button.text.text), ["High", "Low", "Resolved"]);
});

test("without controls the Title is the only top-level block", () => {
  const slack = slackOf(postCard(load({ allowedChannelId: "C999OTHER", allowedSenderId: SENDER })));
  assert.deepEqual(slack.blocks.map((block) => block.type), ["section"]);
  assert.equal(slack.attachments.length, 1);
});

test("the colour bar follows the computed priority: high red, medium amber, low grey, resolved green", () => {
  const colorFor = (fields) => {
    const loaded = load();
    recordRead(loaded);
    return slackOf(postCard(loaded, { fields: { ...summary, ...fields } })).attachments[0].color;
  };
  assert.equal(colorFor({ sampleAffected: 4 }), "#D92D20");
  assert.equal(colorFor({ sampleAffected: 1 }), "#D99A00");
  assert.equal(colorFor({ sampleAffected: 0 }), "#9CA3AF");
  // Verified resolution outranks the priority colour.
  assert.equal(colorFor({ sampleAffected: 4, resolved: true }), "#2E8B57");
});

test("a priority click passes blocks and a recoloured attachment to editMessage", async () => {
  const loaded = load();
  const slack = slackOf(postCard(loaded));
  const click = fakeClick({ value: pick(slack, "High") });
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  const [edit] = click.calls.edits;
  assert.deepEqual(edit.blocks.map((block) => block.type), ["section", "actions"]);
  assert.equal(edit.attachments.length, 1);
  assert.equal(edit.attachments[0].color, "#D92D20");
  assert.equal(edit.attachments[0].blocks[0].text.text, "*Priority:* \u{1F534} High");
  assert.equal(edit.text, "\u{1F534} checkout-api upstream timeouts");

  const resolve = fakeClick({ value: pick({ blocks: edit.blocks }, "Resolved") });
  await loaded.interactive.handler(resolve.ctx);
  assert.equal(resolve.calls.edits[0].attachments[0].color, "#2E8B57");
  // Buttons stay after a resolve so the card can be reopened.
  assert.deepEqual(resolve.calls.edits[0].blocks.map((block) => block.type), ["section", "actions"]);
});

test("an amendment keeps the first post's split: Title and buttons as presentation, colour bar as livexAttachments", () => {
  const loaded = load();
  recordRead(loaded);
  const first = slackOf(postCard(loaded));
  const result = loaded.hooks.get("before_tool_call")(
    {
      toolName: "message",
      params: {
        action: "edit",
        channel: "slack",
        target: CHANNEL,
        messageId: CARD_TS,
        message: `LIVEX_ALERT_SUMMARY_V3\n${JSON.stringify({ ...summary, sampleAffected: 4 })}\n\nfull`,
      },
    },
    { sessionKey: SESSION },
  );
  const { params } = result;
  assert.equal("attachments" in params, false);
  assert.deepEqual(params.presentation.blocks.map((block) => block.type), ["text", "buttons"]);
  assert.equal(params.presentation.blocks[0].text, first.blocks[0].text.text);
  assert.equal(params.livexAttachments.length, 1);
  assert.equal(params.livexAttachments[0].color, "#D92D20");
  // Same attachment content as the first post of the same card, apart from the new priority.
  const fresh = load();
  recordRead(fresh);
  const same = slackOf(postCard(fresh, { fields: { ...summary, sampleAffected: 4 } }));
  assert.deepEqual(params.livexAttachments, same.attachments);
  // The shallow merge of the hook's params over the original keeps the route and adds ours.
  const merged = { ...{ action: "edit", channel: "slack", target: CHANNEL }, ...params };
  assert.equal(merged.action, "edit");
  assert.equal(merged.target, CHANNEL);
  assert.equal(merged.livexAttachments, params.livexAttachments);
});

test("evidence links must open an entry or a bounded time range in Logs Explorer", () => {
  const base = "https://console.cloud.google.com/logs/query";
  const accepted = [
    VERIFIED,
    `${base}?query=insertId%3D%22a%22`,
    `${base}?project=p&query=timestamp%3E%3D%222026-01-21T12%3A20%3A00Z%22%20AND%20timestamp%3C%3D%222026-01-21T12%3A25%3A00Z%22`,
    `${base}?query=timestamp%3C%3D%222026-01-21T12%3A25%3A00Z%22%20timestamp%3E%3D%222026-01-21T12%3A20%3A00Z%22`,
  ];
  for (const link of accepted) {
    assert.equal(readEvidenceHref(link), new URL(link).href, link);
  }
  const dropped = [
    // The exact generic link the model produced before the guard.
    "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=resource.type%3D%22k8s_container%22",
    base,
    `${base}?project=livex-copilot-prd`,
    // One bound is not a slice.
    `${base}?query=timestamp%3E%3D%222026-01-21T12%3A20%3A00Z%22`,
    `${base}?query=timestamp%3C%3D%222026-01-21T12%3A25%3A00Z%22`,
    // insertId only outside the query parameter.
    `${base}?project=insertId%3Dabc&query=severity%3DERROR`,
    `${base};query=insertId%3D%22abc%22`,
    "https://console.cloud.google.com/logs/viewer?query=insertId%3D%22abc%22",
    "https://console.cloud.google.com/logs/query/extra?query=insertId%3D%22abc%22",
    "https://console.cloud.google.com.evil.example/logs/query?query=insertId%3D%22abc%22",
    "https://console.cloud.google.com:8443/logs/query?query=insertId%3D%22abc%22",
  ];
  for (const link of dropped) {
    assert.equal(readEvidenceHref(link), null, link);
  }
  assert.equal(readEvidenceHref(null), null);
  assert.equal(readEvidenceHref("http://console.cloud.google.com/logs/query?query=insertId%3D%22a%22"), null);
  assert.equal(readEvidenceHref(42), undefined);
});

test("a dropped evidence link still posts the card with 'No verified evidence link'", () => {
  const generic = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=resource.type%3D%22k8s_container%22";
  const slack = slackOf(postCard(load(), { fields: { ...summary, evidenceUrl: generic } }));
  const evidence = slack.attachments[0].blocks[4].text.text;
  assert.equal(evidence, `*Evidence:* No verified evidence link · Checked window: ${summary.checkedWindow}`);
  assert.doesNotMatch(JSON.stringify(slack), /<https?:|k8s_container/u);
});

test("a button token minted with a now-dropped link still decodes, without the link", () => {
  const key = randomBytes(32);
  const bind = { channelId: CHANNEL, threadTs: THREAD };
  const generic = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=resource.type%3D%22k8s_container%22";
  const card = {
    priority: "medium",
    why: "client effect not verified (1 of 5 sampled) · known: no · alert: error",
    also: [{ title: "other issue", priority: "low" }],
    resolved: false,
    title: "t",
    summary: "s",
    nextAction: "n",
    owner: "o",
    checkedWindow: "w",
    evidenceHref: generic,
  };
  const token = encodeState(card, bind, key);
  assert.deepEqual(decodeState(token, bind, key), { ...card, evidenceHref: null });
  assert.equal(renderBlocks({ ...card, evidenceHref: null }, undefined).attachments[0].blocks[4].text.text.includes("No verified"), true);
});

// ---------------------------------------------------------------- evidence provenance

const BASE = "https://console.cloud.google.com/logs/query";
const link = (query, project = PROJECT) => `${BASE}?project=${project}&query=${encodeURIComponent(query)}`;
const evidenceOf = (result) => slackOf(result).attachments[0].blocks[4].text.text;
const NO_LINK = `*Evidence:* No verified evidence link · Checked window: ${summary.checkedWindow}`;
const amendCtx = { sessionKey: SESSION, agentId: "debugger", toolName: "message" };
const amend = (loaded, evidenceUrl) =>
  loaded.hooks.get("before_tool_call")(
    { toolName: "message", params: { action: "edit", target: `channel:${CHANNEL}`, messageId: CARD_TS, message: envelope({ ...summary, evidenceUrl }) } },
    amendCtx,
  );
const amendedEvidence = (result) => result.params.livexAttachments[0].blocks[4].text.text;

// Each of these passes the substring shape check (insertId= or both timestamp bounds) but was never
// returned by the log tool.
const FORGED = [
  link('resource.type="k8s_container" -- insertId='),
  link('textPayload:"insertId="'),
  link('jsonPayload.insertId="x"'),
  link('timestamp>="2026-01-21T12:20:00Z" OR timestamp<="2026-01-21T12:25:00Z"'),
  link('insertId="abc124"'),
  link('insertId="abc123" OR severity>=ERROR'),
  VERIFIED.replace("&query", "&extra=1&query"),
];

test("only a link the log tool returned in this session is kept on the card", () => {
  const loaded = load();
  recordEvidence(loaded, { entryUrls: [VERIFIED] });
  for (const forged of FORGED) {
    // The substring check alone would accept it; the recorded-link check drops it.
    assert.equal(readEvidenceHref(forged) !== null, true, forged);
    assert.equal(evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: forged } })), NO_LINK, forged);
  }
  assert.match(evidenceOf(postCard(loaded)), /^\*Evidence:\* <https:\/\/console\.cloud\.google\.com\/logs\/query\?project=livex-copilot-prd&amp;query=insertId%3D%22abc123%22\|Logs>/u);
});

test("a link recorded for one session is not accepted in another or before it is recorded", () => {
  const loaded = load();
  assert.equal(evidenceOf(postCard(loaded)), NO_LINK);
  const other = "agent:debugger:slack:channel:c0alerts1:thread:1768990000.000009";
  recordEvidence(loaded, { entryUrls: [VERIFIED], sessionKey: other });
  assert.equal(evidenceOf(postCard(loaded)), NO_LINK);
  recordEvidence(loaded, { logsExplorerUrl: VERIFIED });
  assert.notEqual(evidenceOf(postCard(loaded)), NO_LINK);
});

test("amendments accept only recorded links too", () => {
  const loaded = load();
  recordEvidence(loaded, { entryUrls: [VERIFIED] });
  postCard(loaded, { fields: { ...summary, evidenceUrl: VERIFIED } });
  for (const forged of FORGED) {
    assert.equal(amendedEvidence(amend(loaded, forged)), NO_LINK, forged);
  }
  assert.match(amendedEvidence(amend(loaded, VERIFIED)), /\|Logs>/u);
});

test("a foreign project is neither recorded nor accepted", () => {
  const foreign = link('insertId="abc123"', "other-project-prd");
  // Recorded under its own project but the card names another: the project check drops it.
  const loaded = load({ ...baseConfig, gcpProject: PROJECT });
  recordEvidence(loaded, { entryUrls: [foreign], project: "other-project-prd" });
  assert.equal(evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: foreign } })), NO_LINK);
  // A tool result for another project than the configured one is not recorded at all.
  recordEvidence(loaded, { entryUrls: [VERIFIED], project: "other-project-prd" });
  assert.equal(evidenceOf(postCard(loaded)), NO_LINK);
  // Without a configured project the link must still belong to the project of its own result.
  const open = load();
  recordEvidence(open, { entryUrls: [foreign], project: PROJECT });
  assert.equal(evidenceOf(postCard(open, { fields: { ...summary, evidenceUrl: foreign } })), NO_LINK);
  // The configured project and the result agree: accepted.
  recordEvidence(loaded, { entryUrls: [VERIFIED], project: PROJECT });
  assert.notEqual(evidenceOf(postCard(loaded)), NO_LINK);
});

test("a real entryUrl and logsExplorerUrl from the log tool are accepted, text-only results too", async () => {
  const config = { gcloudPath: "/sdk/bin/gcloud", cloudSdkConfig: "/private/cloud", gcloudAccount: "reader@example.test", project: "example-prd", allowedSenderId: SENDER, allowedChannelId: CHANNEL };
  const context = { messageChannel: "slack", nativeChannelId: CHANNEL, requesterSenderId: SENDER, assertInvocationCurrent() {} };
  const rows = [{ insertId: 'a"b\\c', timestamp: "2026-11-14T09:12:05.250Z", severity: "ERROR", textPayload: "boom" }];
  const tool = createLogsTool(config, context, async () => ({ code: 0, termination: "exit", killed: false, stdout: JSON.stringify(rows), stderr: "" }));
  const result = await tool.execute("read", { mode: "discover", insertId: "x", start: "2026-11-14T09:00:00Z", end: "2026-11-14T10:00:00Z", limit: 5 });
  const { entryUrl } = result.details.entries[0];
  const { logsExplorerUrl } = result.details;
  assert.ok(entryUrl && logsExplorerUrl);
  const fire = (loaded, toolResult) =>
    loaded.hooks.get("after_tool_call")({ toolName: "livex_gcp_logs_read", params: {}, result: toolResult }, { sessionKey: SESSION, toolName: "livex_gcp_logs_read" });
  for (const toolResult of [result, { content: result.content }]) {
    for (const [name, url] of [["entryUrl", entryUrl], ["logsExplorerUrl", logsExplorerUrl]]) {
      for (const pluginConfig of [baseConfig, { ...baseConfig, gcpProject: "example-prd" }]) {
        const loaded = load(pluginConfig);
        fire(loaded, toolResult);
        const text = evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: url } }));
        assert.match(text, /\|Logs>/u, name);
      }
    }
  }
  // With the other project configured the same real result is ignored.
  const wrong = load({ ...baseConfig, gcpProject: "different-prd" });
  fire(wrong, result);
  assert.equal(evidenceOf(postCard(wrong, { fields: { ...summary, evidenceUrl: entryUrl } })), NO_LINK);
});

test("a count result's samples[].entryUrl and logsExplorerUrl are accepted as card evidence links", async () => {
  const config = { gcloudPath: "/sdk/bin/gcloud", cloudSdkConfig: "/private/cloud", gcloudAccount: "reader@example.test", project: "example-prd", allowedSenderId: SENDER, allowedChannelId: CHANNEL };
  const context = { messageChannel: "slack", nativeChannelId: CHANNEL, requesterSenderId: SENDER, assertInvocationCurrent() {} };
  const rows = [
    { insertId: "close-1", timestamp: "2026-11-14T09:12:05.250Z", severity: "INFO", textPayload: "[PHONE_CLOSE] Closing conversation" },
    { insertId: "close-2", timestamp: "2026-11-14T09:30:00.000Z", severity: "INFO", textPayload: "[PHONE_CLOSE] Closing conversation" },
  ];
  const tool = createLogsTool(config, context, async () => ({ code: 0, termination: "exit", killed: false, stdout: JSON.stringify(rows), stderr: "" }), { now: () => Date.parse("2026-11-14T12:00:00Z") });
  const result = await tool.execute("count", {
    mode: "count",
    resourceType: "k8s_container",
    resourceLabels: { container_name: "chat-engine" },
    phrases: ["[PHONE_CLOSE] Closing conversation"],
    start: "2026-11-14T09:00:00Z",
    end: "2026-11-14T10:00:00Z",
  });
  const [first] = result.details.samples;
  const { logsExplorerUrl } = result.details;
  assert.ok(first?.entryUrl && logsExplorerUrl);
  assert.equal(result.details.entries, undefined, "a count result has no entries[]: samples are the only entry links");
  const fire = (loaded, toolResult) =>
    loaded.hooks.get("after_tool_call")({ toolName: "livex_gcp_logs_read", params: {}, result: toolResult }, { sessionKey: SESSION, toolName: "livex_gcp_logs_read" });
  for (const toolResult of [result, { content: result.content }]) {
    for (const sample of result.details.samples) {
      for (const pluginConfig of [baseConfig, { ...baseConfig, gcpProject: "example-prd" }]) {
        const loaded = load(pluginConfig);
        assert.equal(evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: sample.entryUrl } })), NO_LINK, "not recorded yet");
        fire(loaded, toolResult);
        assert.match(evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: sample.entryUrl } })), /\|Logs>/u, sample.insertId);
      }
    }
  }
  // Only the links the tool returned count: a forged sibling link and another project's result are refused.
  const loaded = load(baseConfig);
  fire(loaded, result);
  assert.equal(evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: first.entryUrl.replace("close-1", "close-9") } })), NO_LINK);
  const wrong = load({ ...baseConfig, gcpProject: "different-prd" });
  fire(wrong, result);
  assert.equal(evidenceOf(postCard(wrong, { fields: { ...summary, evidenceUrl: first.entryUrl } })), NO_LINK);
  // The recorder takes samples from a hand-built count result as well, and ignores a non-array.
  const manual = load(baseConfig);
  fire(manual, { details: { project: PROJECT, samples: [{ phrase: "p", entryUrl: VERIFIED }, null, { entryUrl: 5 }] } });
  assert.notEqual(evidenceOf(postCard(manual)), NO_LINK);
  const none = load(baseConfig);
  fire(none, { details: { project: PROJECT, samples: "nope" } });
  assert.equal(evidenceOf(postCard(none)), NO_LINK);
});

test("only successful livex_gcp_logs_read results in a debugger thread are recorded", () => {
  const loaded = load();
  recordEvidence(loaded, { entryUrls: [VERIFIED], toolName: "exec" });
  recordEvidence(loaded, { entryUrls: [VERIFIED], error: "boom" });
  recordEvidence(loaded, { entryUrls: [VERIFIED], sessionKey: "agent:main:slack:channel:c0alerts1:thread:1768996800.000001" });
  recordEvidence(loaded, { entryUrls: [VERIFIED], sessionKey: null });
  for (const result of [undefined, null, "x", { details: "x" }, { content: "x" }, { content: [{ type: "text", text: "{bad" }] }]) {
    loaded.hooks.get("after_tool_call")({ toolName: "livex_gcp_logs_read", params: {}, result }, { sessionKey: SESSION });
  }
  assert.equal(loaded.hooks.get("after_tool_call")(undefined, undefined), undefined);
  assert.equal(evidenceOf(postCard(loaded)), NO_LINK);
});

test("recorded links expire, and each session and the session count are bounded", () => {
  let clock = 1_000_000;
  // The plugin binds Date.now when it is created, so install the clock first.
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const loaded = load(baseConfig);
    recordEvidence(loaded, { entryUrls: [VERIFIED] });
    assert.notEqual(evidenceOf(postCard(loaded)), NO_LINK);
    clock += 3 * 60 * 60_000 + 1;
    assert.equal(evidenceOf(postCard(loaded)), NO_LINK);

    // 250 links in one session keep only the newest 200.
    const urls = Array.from({ length: 250 }, (_, index) => link(`insertId="n${index}"`));
    recordEvidence(loaded, { entryUrls: urls });
    const kept = (url) => !evidenceOf(postCard(loaded, { fields: { ...summary, evidenceUrl: url } })).includes("No verified");
    assert.equal(kept(urls[0]), false);
    assert.equal(kept(urls[49]), false);
    assert.equal(kept(urls[50]), true);
    assert.equal(kept(urls[249]), true);

    // 501 sessions: the least recently recorded one is evicted.
    const sessionOf = (index) => `agent:debugger:slack:channel:c0alerts1:thread:1768996800.${String(index).padStart(6, "0")}`;
    for (let index = 0; index < 501; index += 1) {
      recordEvidence(loaded, { entryUrls: [VERIFIED], sessionKey: sessionOf(index) });
    }
    const sessionKept = (index) =>
      !evidenceOf(postCard(loaded, { sessionKey: sessionOf(index), ts: `1768997000.${String(index).padStart(6, "0")}` })).includes("No verified");
    assert.equal(sessionKept(0), false);
    assert.equal(sessionKept(1), true);
    assert.equal(sessionKept(500), true);
  } finally {
    Date.now = realNow;
  }
});

test("logs reads are counted per thread and a capped, incomplete or failed read marks it degraded", () => {
  const loaded = load();
  const call = (target, event) => target.hooks.get("after_tool_call")(event, { sessionKey: SESSION });
  assert.deepEqual(readStats(loaded, SESSION), { ok: 0, degraded: false });
  call(loaded, { toolName: "livex_gcp_logs_read", result: { details: { entries: [], truncated: false, truncationReasons: [] } } });
  assert.deepEqual(readStats(loaded, SESSION), { ok: 1, degraded: false });
  call(loaded, { toolName: "livex_repository_read", result: { details: { truncated: true } } });
  assert.deepEqual(readStats(loaded, SESSION), { ok: 1, degraded: false });
  for (const details of [{ truncated: true }, { complete: false }, { truncationReasons: ["row-limit"] }]) {
    const fresh = load();
    call(fresh, { toolName: "livex_gcp_logs_read", result: { details } });
    assert.deepEqual(readStats(fresh, SESSION), { ok: 1, degraded: true });
  }
  const failed = load();
  call(failed, { toolName: "livex_gcp_logs_read", error: "boom" });
  assert.deepEqual(readStats(failed, SESSION), { ok: 0, degraded: true });
  assert.deepEqual(readStats(loaded, "agent:debugger:slack:channel:c0other:thread:1.2"), { ok: 0, degraded: false });
});

test("card plugin and memory plugin accept and reject the same V3 envelopes", async () => {
  const lite = await import("../livex-investigations-lite/core.mjs");
  const variants = [{}, { priority: "high" }, { sampleAffected: 9 }, { known: "maybe" }, { alertClass: "Bad Class" }, { knownRef: "x".repeat(201) }, { scope: "many" }, { extra: 1 }];
  for (const v of variants) {
    const text = envelope({ ...summary, ...v });
    assert.equal(Boolean(classifyEnvelope(text).card), Boolean(lite.readSummaryEnvelope(text).record), JSON.stringify(v));
  }
});

test("card plugin and memory plugin agree on alternates, evidence links and optional fields", async () => {
  const lite = await import("../livex-investigations-lite/core.mjs");
  const facts = Object.fromEntries(
    ["alertClass", "service", "alertSeverity", "sustained", "known", "sampleChecked", "sampleAffected", "scope", "traffic", "clientEffectVerified"].map((key) => [key, summary[key]]),
  );
  const alternate = { title: "Other category", ...facts, known: "ongoing", knownRef: "LX-1234" };
  const variants = [
    { alternates: [alternate] },
    { alternates: [] },
    { alternates: Array(4).fill(alternate) },
    { alternates: Array(5).fill(alternate) },
    { alternates: [{ ...alternate, signature: "x | y" }] },
    { alternates: [{ ...alternate, title: "" }] },
    { alternates: [{ ...alternate, sampleAffected: 6 }] },
    { alternates: [{ ...alternate, knownRef: undefined }] },
    { alternates: [{ ...alternate, scope: undefined }] },
    { alternates: [null] },
    { alternates: [[]] },
    { alternates: {} },
    { evidenceUrl: null },
    { evidenceUrl: "https://example.com/not-a-logs-link" },
    { evidenceUrl: "not a url" },
    { evidenceUrl: 7 },
    { resolved: true },
    { resolved: "yes" },
    { knownRef: "INC-7", known: "fixed" },
    { knownRef: "" },
    { sampleChecked: 501, sampleAffected: 0 },
    { sampleChecked: 0, sampleAffected: 0 },
    { sampleChecked: 1.5 },
    { sustained: "no" },
    { clientEffectVerified: null },
    { alertSeverity: "critical" },
    { traffic: "staging" },
    { service: "a" },
    { title: "t".repeat(121) },
    { signature: "s".repeat(161) },
    { summary: "x".repeat(601) },
    { nextAction: "line\nbreak" },
    { owner: " " },
    { checkedWindow: "w".repeat(81) },
    { provisional: false },
  ];
  for (const v of variants) {
    const text = envelope({ ...summary, ...v });
    assert.equal(Boolean(classifyEnvelope(text).card), Boolean(lite.readSummaryEnvelope(text).record), JSON.stringify(v));
  }
  const { alertClass, ...missing } = summary;
  for (const text of [envelope(missing), envelope(summary, undefined, "LIVEX_ALERT_SUMMARY_V2"), ` \n${envelope(summary)}`, `x\n${envelope(summary)}`]) {
    assert.equal(Boolean(classifyEnvelope(text).card), Boolean(lite.readSummaryEnvelope(text).record), text.slice(0, 30));
  }
});
