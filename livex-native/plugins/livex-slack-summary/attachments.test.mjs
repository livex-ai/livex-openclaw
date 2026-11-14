import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decodeState, encodeState, readEvidenceHref, renderBlocks } from "./core.mjs";
import { CARD_TS, CHANNEL, SENDER, SESSION, THREAD, buttonsOf, fakeClick, flat, load, postCard, summary } from "./test-helpers.mjs";

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
    ["section", "section", "section", "section", "context"],
  );
  assert.deepEqual(
    attachment.blocks.slice(0, 4).map((block) => block.text.text.match(/^\*([^:]+):\*/u)[1]),
    ["Priority", "Next action", "Summary", "Evidence"],
  );
  assert.ok(attachment.blocks.length <= 10);
  // Priority keeps its emoji in the attachment.
  assert.equal(attachment.blocks[0].text.text, "*Priority:* \u{1F7E1} Medium (provisional)");
  assert.equal(attachment.fallback.includes("<http"), false);
  assert.match(attachment.fallback, /^\*Title:\* .*\n\*Priority:\* /u);
  assert.deepEqual(buttonsOf(slack.blocks).map((button) => button.text.text), ["High", "Medium", "Low", "Resolved"]);
});

test("without controls the Title is the only top-level block", () => {
  const slack = slackOf(postCard(load({ allowedChannelId: "C999OTHER", allowedSenderId: SENDER })));
  assert.deepEqual(slack.blocks.map((block) => block.type), ["section"]);
  assert.equal(slack.attachments.length, 1);
});

test("the colour bar mirrors PR 1: high and critical red, medium amber, resolved green, else grey", () => {
  const colorFor = (fields) => slackOf(postCard(load(), { fields: { ...summary, ...fields } })).attachments[0].color;
  assert.equal(colorFor({ priority: "high", provisional: false }), "#D92D20");
  assert.equal(colorFor({ priority: "critical", provisional: false }), "#D92D20");
  assert.equal(colorFor({ priority: "medium" }), "#D99A00");
  assert.equal(colorFor({ priority: "low" }), "#9CA3AF");
  assert.equal(colorFor({ priority: "unknown" }), "#9CA3AF");
  // Verified resolution outranks the priority colour.
  assert.equal(colorFor({ priority: "high", resolved: true }), "#2E8B57");
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
  const first = slackOf(postCard(loaded));
  const result = loaded.hooks.get("before_tool_call")(
    {
      toolName: "message",
      params: {
        action: "edit",
        channel: "slack",
        target: CHANNEL,
        messageId: CARD_TS,
        message: `LIVEX_ALERT_SUMMARY_V2\n${JSON.stringify({ ...summary, priority: "high", provisional: false })}\n\nfull`,
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
  const same = slackOf(postCard(load(), { fields: { ...summary, priority: "high", provisional: false } }));
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
  assert.equal(readEvidenceHref("http://console.cloud.google.com/logs/query?query=insertId%3D%22a%22"), undefined);
});

test("a dropped evidence link still posts the card with 'No verified evidence link'", () => {
  const generic = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=resource.type%3D%22k8s_container%22";
  const slack = slackOf(postCard(load(), { fields: { ...summary, evidenceUrl: generic } }));
  const evidence = slack.attachments[0].blocks[3].text.text;
  assert.equal(evidence, `*Evidence:* No verified evidence link · Checked window: ${summary.checkedWindow}`);
  assert.doesNotMatch(JSON.stringify(slack), /<https?:|k8s_container/u);
});

test("a button token minted with a now-dropped link still decodes, without the link", () => {
  const key = randomBytes(32);
  const bind = { channelId: CHANNEL, threadTs: THREAD };
  const generic = "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=resource.type%3D%22k8s_container%22";
  const card = {
    priority: "medium",
    provisional: true,
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
  assert.equal(renderBlocks({ ...card, evidenceHref: null }, undefined).attachments[0].blocks[3].text.text.includes("No verified"), true);
});
