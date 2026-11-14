import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { loadOrCreateKey } from "./core.mjs";
import { CARD_TS, CHANNEL, SENDER, SESSION, THREAD, baseConfig, buttonsOf, fakeClick, fakeStore, labelsOf, load, loadWithStore, postCard, summary } from "./test-helpers.mjs";

const blocksOf = (result) => result.payload.channelData.slack.blocks;
const pick = (blocks, label) => buttonsOf(blocks).find((button) => button.text.text === label).value;
const tokenOf = (value) => value.split(":").slice(2).join(":");

test("a configured card carries priority buttons and registers one Slack handler", () => {
  const loaded = load();
  assert.equal(loaded.registrations.length, 1);
  assert.equal(loaded.interactive.channel, "slack");
  assert.equal(loaded.interactive.namespace, "livex-priority");
  assert.equal(typeof loaded.interactive.handler, "function");

  const blocks = blocksOf(postCard(loaded));
  assert.equal(blocks.length, 6);
  assert.equal(blocks[0].text.text, "\u{1F7E1} Priority: Medium (provisional)");
  // Medium is provisional, so confirming it stays available.
  assert.deepEqual(labelsOf(blocks), ["High", "Medium", "Low", "Resolved"]);
  const buttons = buttonsOf(blocks);
  assert.deepEqual(
    buttons.map((button) => button.action_id),
    [1, 2, 3, 4].map((n) => `openclaw:callback_button:1:${n}`),
  );
  for (const button of buttons) {
    assert.match(button.value, /^livex-priority:(high|medium|low|resolved):i[A-Za-z0-9_-]+$/u);
    assert.ok(button.value.length <= 2000);
  }
  assert.equal(buttons[3].style, "primary");
});

test("buttons are absent without both gates, outside the allowed channel, and the card is otherwise unchanged", () => {
  const configs = [null, {}, { allowedSenderId: SENDER }, { allowedChannelId: CHANNEL }, { allowedChannelId: CHANNEL, allowedSenderId: "${SLACK_SENDER_ID}" }];
  for (const config of configs) {
    const loaded = load(config);
    assert.equal(loaded.registrations.length, 0, JSON.stringify(config));
    assert.equal(blocksOf(postCard(loaded)).length, 5);
  }
  const wrongChannel = load({ allowedChannelId: "C0OTHER9", allowedSenderId: SENDER });
  assert.equal(blocksOf(postCard(wrongChannel)).length, 5);
  assert.equal(blocksOf(postCard(load({ allowedChannelId: "*", allowedSenderId: SENDER }))).length, 6);
});

test("a click from anyone but the allowed sender is refused and changes nothing", async () => {
  const loaded = load();
  const value = pick(blocksOf(postCard(loaded)), "High");
  for (const sender of ["U0OTHER", null, "", SENDER.toLowerCase()]) {
    const click = fakeClick({ value, sender });
    assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
    assert.deepEqual(click.calls.edits, []);
    assert.equal(click.calls.replies.length, 1);
    assert.equal(click.calls.replies[0].responseType, "ephemeral");
  }
  // The channel gate refuses a click from another channel too.
  const strict = load({ allowedChannelId: CHANNEL, allowedSenderId: SENDER });
  const click = fakeClick({ value, conversationId: "C0ELSEWHERE" });
  await strict.interactive.handler(click.ctx);
  assert.deepEqual(click.calls.edits, []);
  assert.equal(click.calls.replies.length, 1);
});

test("a priority click edits the card in place with the new priority and refreshed buttons", async () => {
  const loaded = load();
  const blocks = blocksOf(postCard(loaded));
  const click = fakeClick({ value: pick(blocks, "High") });
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(click.calls.replies, []);
  assert.equal(click.calls.edits.length, 1);
  const edited = click.calls.edits[0];
  assert.equal(edited.text, "\u{1F534} Priority: High");
  assert.equal(edited.blocks[0].text.text, "\u{1F534} Priority: High");
  // Body, evidence link and hint are untouched.
  assert.deepEqual(edited.blocks.slice(1, 5), blocks.slice(1, 5));
  assert.deepEqual(labelsOf(edited.blocks), ["Medium", "Low", "Resolved"]);

  // The refreshed buttons carry the new state: a second click works from the edit.
  const second = fakeClick({ value: pick(edited.blocks, "Low") });
  await loaded.interactive.handler(second.ctx);
  assert.equal(second.calls.edits[0].blocks[0].text.text, "⚪ Priority: Low");
});

test("Resolved closes the card, keeps the priority it had, and a priority click reopens it", async () => {
  const loaded = load();
  const blocks = blocksOf(postCard(loaded, { fields: { ...summary, priority: "high", provisional: false } }));
  assert.deepEqual(labelsOf(blocks), ["Medium", "Low", "Resolved"]);
  const click = fakeClick({ value: pick(blocks, "Resolved") });
  await loaded.interactive.handler(click.ctx);
  const resolved = click.calls.edits[0];
  assert.equal(resolved.blocks[0].text.text, "\u{1F7E2} Resolved · was High");
  assert.deepEqual(labelsOf(resolved.blocks), ["High", "Medium", "Low"]);

  const reopen = fakeClick({ value: pick(resolved.blocks, "Medium") });
  await loaded.interactive.handler(reopen.ctx);
  assert.equal(reopen.calls.edits[0].blocks[0].text.text, "\u{1F7E1} Priority: Medium");
});

test("a tampered, malformed or oversized value fails closed with an ephemeral notice", async () => {
  const loaded = load();
  const good = pick(blocksOf(postCard(loaded)), "High");
  const row = (patch) => {
    const base = ["medium", 1, 0, "impact", "next", "owner", "window", null];
    return `i${deflateRawSync(Buffer.from(JSON.stringify(patch(base)))).toString("base64url")}`;
  };
  const tokens = [
    "",
    "i",
    "x" + tokenOf(good).slice(1),
    "i" + "A".repeat(3000),
    "r" + "unknown_reference",
    "i!!!not-base64!!!",
    row((r) => r.slice(0, 7)),
    row((r) => [...r, "extra"]),
    row((r) => ["urgent", ...r.slice(1)]),
    row((r) => [r[0], 2, ...r.slice(2)]),
    row((r) => [r[0], "1", ...r.slice(2)]),
    row((r) => [r[0], r[1], null, ...r.slice(3)]),
    row((r) => [...r.slice(0, 3), "x".repeat(241), ...r.slice(4)]),
    row((r) => [...r.slice(0, 3), "line\nbreak", ...r.slice(4)]),
    row((r) => [...r.slice(0, 7), "https://evil.example/logs"]),
    row((r) => [...r.slice(0, 7), "http://console.cloud.google.com/logs"]),
    row((r) => [...r.slice(0, 7), 42]),
    // A bomb inflates far past the 8 KiB state cap.
    `i${deflateRawSync(Buffer.alloc(200_000, 65)).toString("base64url")}`,
  ];
  const values = [
    ...tokens.map((token) => `livex-priority:high:${token}`),
    `livex-priority:escalate:${tokenOf(good)}`,
    `livex-priority:${tokenOf(good)}`,
    "livex-priority:",
    "livex-priority:high",
  ];
  for (const value of values) {
    const click = fakeClick({ value });
    assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true }, value.slice(0, 60));
    assert.equal(click.calls.edits.length, 0, `edited for ${value.slice(0, 90)}`);
    assert.equal(click.calls.replies.length, 1, value.slice(0, 60));
    assert.equal(click.calls.replies[0].responseType, "ephemeral");
  }
  for (const odd of [{ kind: "select" }, { messageTs: null }]) {
    const click = fakeClick({ value: good, ...odd });
    await loaded.interactive.handler(click.ctx);
    assert.deepEqual(click.calls.edits, []);
  }
});

test("a card too large for a button value keeps working through the bounded reference store", async () => {
  const loaded = load();
  // High-entropy text over a 79-character alphabet that stays valid in model fields and URLs:
  // about 6.3 bits per character, so the 2,000+ card characters cannot deflate below the limit.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$'()*+,;=:@/";
  let noise = "";
  for (let block = Buffer.from("seed"); noise.length < 2000; ) {
    block = createHash("sha512").update(block).digest();
    noise += [...block].map((byte) => alphabet[byte % alphabet.length]).join("");
  }
  const evidenceUrl = `https://console.cloud.google.com/logs/query;query=${noise.slice(0, 1550)}`;
  const blocks = blocksOf(postCard(loaded, { fields: { ...summary, evidenceUrl, impact: noise.slice(1550, 1790), nextAction: noise.slice(1790, 1910), checkedWindow: noise.slice(1910, 1974) } }));
  const buttons = buttonsOf(blocks);
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    assert.ok(button.value.length <= 2000, String(button.value.length));
  }
  assert.match(buttons[0].value, /^livex-priority:high:r[A-Za-z0-9_-]+$/u);
  const click = fakeClick({ value: pick(blocks, "High") });
  await loaded.interactive.handler(click.ctx);
  assert.equal(click.calls.edits.length, 1);
  assert.match(click.calls.edits[0].blocks[4].elements[0].text, /^<https:\/\/console\.cloud\.google\.com\/logs\/query;query=[^|]+\|View evidence>$/u);
});

test("a Slack edit failure is reported to the clicker and never thrown", async () => {
  const loaded = load();
  const click = fakeClick({ value: pick(blocksOf(postCard(loaded)), "High") });
  click.ctx.respond.editMessage = async () => {
    throw new Error("slack down");
  };
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.equal(click.calls.replies.length, 1);
  click.ctx.respond.reply = async () => {
    throw new Error("response_url expired");
  };
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(await loaded.interactive.handler(undefined), { handled: true });
  assert.deepEqual(await loaded.interactive.handler({}), { handled: true });
});

const refused = async (loaded, click) => {
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(click.calls.edits, []);
  assert.equal(click.calls.replies.length, 1);
  assert.equal(click.calls.replies[0].responseType, "ephemeral");
};

test("a well-formed but unsigned token is refused", async () => {
  const loaded = load();
  const forged = `i${deflateRawSync(Buffer.from(JSON.stringify(["high", 0, 0, "impact", "next", "owner", "window", null]))).toString("base64url")}`;
  for (const token of [forged, `${forged}${"A".repeat(22)}`]) {
    await refused(loaded, fakeClick({ value: `livex-priority:high:${token}` }));
  }
});

test("a real token replayed onto another thread or channel, or with a tampered tag, is refused", async () => {
  const loaded = load({ allowedChannelId: "*", allowedSenderId: SENDER });
  const value = pick(blocksOf(postCard(loaded)), "High");
  await refused(loaded, fakeClick({ value, threadTs: "1768996800.999999" }));
  await refused(loaded, fakeClick({ value, threadTs: "" }));
  await refused(loaded, fakeClick({ value, conversationId: "C0ELSEWHERE" }));
  // Flip a character in the middle of the tag: always a different tag.
  const mid = value.length - 11;
  const flipped = value.slice(0, mid) + (value[mid] === "A" ? "B" : "A") + value.slice(mid + 1);
  await refused(loaded, fakeClick({ value: flipped }));
  // The last tag character carries 4 unused bits. A spelling that decodes to the same bytes
  // is still a different string and is refused.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = value.at(-1);
  const sameBytes = [...alphabet].filter(
    (ch) => ch !== last && Buffer.from(`AAAAAAAAAAAAAAAAAAAAA${ch}`, "base64url").equals(Buffer.from(`AAAAAAAAAAAAAAAAAAAAA${last}`, "base64url")),
  );
  assert.ok(sameBytes.length > 0);
  for (const ch of sameBytes) {
    await refused(loaded, fakeClick({ value: value.slice(0, -1) + ch }));
  }
  const body = value.replace(/^(livex-priority:high:i.)(.)/u, (_, head, ch) => head + (ch === "A" ? "B" : "A"));
  await refused(loaded, fakeClick({ value: body }));
  // The untouched value still works, and ctx.threadId stands in for a missing interaction.threadTs.
  const ok = fakeClick({ value });
  await loaded.interactive.handler(ok.ctx);
  assert.equal(ok.calls.edits.length, 1);
  const viaCtx = fakeClick({ value, threadTs: undefined });
  delete viaCtx.ctx.interaction.threadTs;
  viaCtx.ctx.threadId = THREAD;
  await loaded.interactive.handler(viaCtx.ctx);
  assert.equal(viaCtx.calls.edits.length, 1);
});

test("a reference token is bound to its card's channel and thread", async () => {
  const loaded = load({ allowedChannelId: "*", allowedSenderId: SENDER });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$'()*+,;=:@/";
  let noise = "";
  for (let block = Buffer.from("bind"); noise.length < 2000; ) {
    block = createHash("sha512").update(block).digest();
    noise += [...block].map((byte) => alphabet[byte % alphabet.length]).join("");
  }
  const fields = { ...summary, evidenceUrl: `https://console.cloud.google.com/logs/query;query=${noise.slice(0, 1550)}`, impact: noise.slice(1550, 1790), nextAction: noise.slice(1790, 1910), checkedWindow: noise.slice(1910, 1974) };
  const value = pick(blocksOf(postCard(loaded, { fields })), "High");
  assert.match(value, /^livex-priority:high:r/u);
  await refused(loaded, fakeClick({ value, threadTs: "1768996800.999999" }));
  await refused(loaded, fakeClick({ value, conversationId: "C0ELSEWHERE" }));
  const ok = fakeClick({ value });
  await loaded.interactive.handler(ok.ctx);
  assert.equal(ok.calls.edits.length, 1);
});

test("the signing key is persisted, so buttons survive a restart; without the store they fail closed", async () => {
  const store = fakeStore();
  const before = await loadWithStore(store);
  assert.equal(store.opened.namespace, "hmac-key");
  assert.equal(store.rows.size, 1);
  const stored = store.rows.get("key").key;
  assert.equal(Buffer.from(stored, "base64url").length, 32);
  const value = pick(blocksOf(postCard(before)), "High");

  const after = await loadWithStore(store); // the "restarted" gateway reads the same row
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get("key").key, stored);
  const click = fakeClick({ value });
  await after.interactive.handler(click.ctx);
  assert.equal(click.calls.edits.length, 1);

  // A card rendered by the restarted gateway is signed with the same key.
  const fresh = pick(blocksOf(postCard(after)), "Low");
  const again = fakeClick({ value: fresh });
  await before.interactive.handler(again.ctx);
  assert.equal(again.calls.edits.length, 1);

  // No keyed store, or a failing one: a per-process key, so older cards fail closed after a restart.
  for (const unavailable of [undefined, fakeStore({ failing: true })]) {
    const first = await loadWithStore(unavailable);
    const second = await loadWithStore(unavailable);
    await refused(second, fakeClick({ value: pick(blocksOf(postCard(first)), "High") }));
    const own = fakeClick({ value: pick(blocksOf(postCard(second)), "High") });
    await second.interactive.handler(own.ctx);
    assert.equal(own.calls.edits.length, 1);
  }
});

test("hooks wait for the key to load, then run synchronously", async () => {
  const store = fakeStore();
  const loaded = load(baseConfig, store);
  // The reply hook never waits; the confirmation hook waits only while the key loads.
  const first = postCard(loaded);
  assert.equal(blocksOf(first).length, 6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof loaded.hooks.get("message_sent")({}, {}), "undefined");
});

test("a store whose lookup never settles does not hold back the reply hook or leak the envelope", async () => {
  const store = fakeStore({ hang: true });
  const loaded = load(baseConfig, store);
  // The reply hook is not gated on the key: a synchronous, rendered card.
  const result = postCard(loaded);
  assert.equal(typeof result.then, "undefined");
  const blocks = blocksOf(result);
  assert.equal(blocks.length, 6);
  assert.doesNotMatch(JSON.stringify(result), /private IDs|LIVEX_ALERT_SUMMARY_V1/u);
  // A click waits at most about two seconds, then proceeds with the interim key,
  // which signed this card, so it works.
  const started = Date.now();
  const click = fakeClick({ value: pick(blocks, "High") });
  await loaded.interactive.handler(click.ctx);
  assert.ok(Date.now() - started < 4000);
  assert.equal(click.calls.edits.length, 1);
});

test("two loaders racing on one store end with the same key", async () => {
  const store = fakeStore();
  const [a, b] = await Promise.all([loadOrCreateKey(store), loadOrCreateKey(store)]);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get("key").key, a.toString("base64url"));
  // A store that cannot create the key yields none, and the caller keeps its interim key.
  assert.equal(await loadOrCreateKey(fakeStore({ failing: true })), undefined);
});
