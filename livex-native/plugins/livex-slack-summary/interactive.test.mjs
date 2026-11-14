import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { loadSigningKey } from "./core.mjs";
import { CHANNEL, SENDER, THREAD, baseConfig, buttonsOf, fakeClick, labelsOf, load, newStateDir, flat, postCard, summary } from "./test-helpers.mjs";

const blocksOf = (result) => flat(result.payload.channelData.slack);
const pick = (blocks, label) => buttonsOf(blocks).find((button) => button.text.text === label).value;
const tokenOf = (value) => value.split(":").slice(2).join(":");
const priorityOf = (blocks) => blocks[1].text.text;
const keyPath = (stateDir) => join(stateDir, "plugins", "livex-slack-summary", "button-key");

/** A click that must leave the card exactly as it is: no edit and no respond call of any kind. */
const refused = async (loaded, click) => {
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(click.calls.edits, []);
  assert.deepEqual(click.calls.replies, []);
};

test("a configured card carries priority buttons and registers one Slack handler", () => {
  const loaded = load();
  assert.equal(loaded.registrations.length, 1);
  assert.equal(loaded.interactive.channel, "slack");
  assert.equal(loaded.interactive.namespace, "livex-priority");
  assert.equal(typeof loaded.interactive.handler, "function");

  const blocks = blocksOf(postCard(loaded));
  assert.equal(blocks.length, 7);
  assert.equal(priorityOf(blocks), "*Priority:* \u{1F7E1} Medium (provisional)");
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
    assert.equal(blocksOf(postCard(loaded)).length, 6);
  }
  const wrongChannel = load({ allowedChannelId: "C0OTHER9", allowedSenderId: SENDER });
  assert.equal(blocksOf(postCard(wrongChannel)).length, 6);
  assert.equal(blocksOf(postCard(load({ allowedChannelId: "*", allowedSenderId: SENDER }))).length, 7);
});

test("a click from anyone but the allowed sender is refused, changes nothing and logs a warning", async () => {
  const loaded = load();
  const value = pick(blocksOf(postCard(loaded)), "High");
  for (const sender of ["U0OTHER", null, "", SENDER.toLowerCase()]) {
    await refused(loaded, fakeClick({ value, sender }));
  }
  assert.equal(loaded.warnings.length, 4);
  // The channel gate refuses a click from another channel too.
  const strict = load({ allowedChannelId: CHANNEL, allowedSenderId: SENDER });
  await refused(strict, fakeClick({ value, conversationId: "C0ELSEWHERE" }));
  assert.equal(strict.warnings.length, 1);
});

test("a priority click edits the card in place with the new priority and refreshed buttons", async () => {
  const loaded = load();
  const blocks = blocksOf(postCard(loaded));
  const click = fakeClick({ value: pick(blocks, "High") });
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(click.calls.replies, []);
  assert.equal(click.calls.edits.length, 1);
  const edited = click.calls.edits[0];
  assert.equal(edited.text, "\u{1F534} checkout-api upstream timeouts");
  assert.equal(priorityOf(flat(edited)), "*Priority:* \u{1F534} High");
  // Everything but the priority line and the buttons is untouched.
  assert.deepEqual(flat(edited).slice(2, 6), blocks.slice(2, 6));
  assert.deepEqual(flat(edited)[0], blocks[0]);
  assert.deepEqual(labelsOf(flat(edited)), ["Medium", "Low", "Resolved"]);
  assert.deepEqual(loaded.warnings, []);

  // The refreshed buttons carry the new state: a second click works from the edit.
  const second = fakeClick({ value: pick(flat(edited), "Low") });
  await loaded.interactive.handler(second.ctx);
  assert.equal(priorityOf(flat(second.calls.edits[0])), "*Priority:* ⚪ Low");
});

test("Resolved closes the card, keeps the priority it had, and a priority click reopens it", async () => {
  const loaded = load();
  const blocks = blocksOf(postCard(loaded, { fields: { ...summary, priority: "high", provisional: false } }));
  assert.deepEqual(labelsOf(blocks), ["Medium", "Low", "Resolved"]);
  const click = fakeClick({ value: pick(blocks, "Resolved") });
  await loaded.interactive.handler(click.ctx);
  const resolved = click.calls.edits[0];
  assert.equal(priorityOf(flat(resolved)), "*Priority:* \u{1F7E2} Resolved · was High");
  assert.equal(resolved.text, "\u{1F7E2} checkout-api upstream timeouts");
  assert.deepEqual(labelsOf(flat(resolved)), ["High", "Medium", "Low"]);

  const reopen = fakeClick({ value: pick(flat(resolved), "Medium") });
  await loaded.interactive.handler(reopen.ctx);
  assert.equal(priorityOf(flat(reopen.calls.edits[0])), "*Priority:* \u{1F7E1} Medium");
});

test("a tampered, malformed or oversized value is refused with no respond call", async () => {
  const loaded = load();
  const good = pick(blocksOf(postCard(loaded)), "High");
  const row = (patch) => {
    const base = ["medium", 1, 0, "title", "summary", "next", "owner", "window", null];
    return `i${deflateRawSync(Buffer.from(JSON.stringify(patch(base)))).toString("base64url")}`;
  };
  const tokens = [
    "",
    "i",
    "x" + tokenOf(good).slice(1),
    "i" + "A".repeat(3000),
    "r" + "unknown_reference",
    "i!!!not-base64!!!",
    row((r) => r.slice(0, 8)),
    row((r) => [...r, "extra"]),
    row((r) => ["urgent", ...r.slice(1)]),
    row((r) => [r[0], 2, ...r.slice(2)]),
    row((r) => [r[0], "1", ...r.slice(2)]),
    row((r) => [r[0], r[1], null, ...r.slice(3)]),
    row((r) => [...r.slice(0, 4), "x".repeat(601), ...r.slice(5)]),
    row((r) => [...r.slice(0, 3), "line\nbreak", ...r.slice(4)]),
    row((r) => [...r.slice(0, 8), "https://evil.example/logs"]),
    row((r) => [...r.slice(0, 8), "http://console.cloud.google.com/logs"]),
    row((r) => [...r.slice(0, 8), 42]),
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
    await refused(loaded, fakeClick({ value }));
  }
  for (const odd of [{ kind: "select" }, { messageTs: null }]) {
    await refused(loaded, fakeClick({ value: good, ...odd }));
  }
  assert.equal(loaded.warnings.length, values.length + 2);
});

// High-entropy text over a 79-character alphabet that stays valid in model fields and URLs:
// about 6.3 bits per character, so a maximal card cannot deflate below the button limit.
function noiseOf(seed, length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$'()*+,;=:@/";
  let noise = "";
  for (let block = Buffer.from(seed); noise.length < length; ) {
    block = createHash("sha512").update(block).digest();
    noise += [...block].map((byte) => alphabet[byte % alphabet.length]).join("");
  }
  return noise;
}
const maximalFields = (noise) => ({
  ...summary,
  title: noise.slice(0, 120),
  summary: noise.slice(120, 720),
  nextAction: noise.slice(720, 1020),
  owner: noise.slice(1020, 1100),
  checkedWindow: noise.slice(1100, 1180),
  evidenceUrl: `https://console.cloud.google.com/logs/query?query=insertId%3D${noise.slice(1180, 2650)}`,
});

test("a card too large for a button value renders without buttons and logs", () => {
  const loaded = load();
  const blocks = blocksOf(postCard(loaded, { fields: maximalFields(noiseOf("seed", 2700)) }));
  assert.deepEqual(buttonsOf(blocks), []);
  assert.equal(blocks.length, 6);
  assert.match(blocks[4].text.text, /^\*Evidence:\* <https:\/\/console\.cloud\.google\.com\/logs\/query\?query=insertId%3D/u);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /too large/u);
  // A card whose state does fit keeps its buttons.
  assert.equal(buttonsOf(blocksOf(postCard(loaded))).length, 4);
});

test("a Slack edit failure never throws, never replies, and logs", async () => {
  const loaded = load();
  const click = fakeClick({ value: pick(blocksOf(postCard(loaded)), "High") });
  click.ctx.respond.editMessage = async () => {
    throw new Error("slack down");
  };
  assert.deepEqual(await loaded.interactive.handler(click.ctx), { handled: true });
  assert.deepEqual(click.calls.replies, []);
  assert.equal(loaded.warnings.length, 1);
  assert.deepEqual(await loaded.interactive.handler(undefined), { handled: true });
  assert.deepEqual(await loaded.interactive.handler({}), { handled: true });
});

test("warnings reach console.warn without a logger and never contain the token or the key", async () => {
  const original = console.warn;
  const logged = [];
  console.warn = (...args) => void logged.push(args.join(" "));
  try {
    const loaded = load(baseConfig, { logger: false });
    const value = pick(blocksOf(postCard(loaded)), "High");
    await refused(loaded, fakeClick({ value, sender: "U0OTHER" }));
    await refused(loaded, fakeClick({ value: `${value.slice(0, -3)}AAA` }));
    assert.equal(logged.length, 2);
    const key = readFileSync(keyPath(loaded.stateDir), "utf8");
    for (const line of logged) {
      assert.ok(!line.includes(tokenOf(value)) && !line.includes(key) && !line.includes("livex-priority:"));
    }
    // A corrupt key file is reported the same way, without its contents.
    const stateDir = newStateDir();
    load(baseConfig, { stateDir });
    writeFileSync(keyPath(stateDir), "secret-looking-garbage");
    load(baseConfig, { stateDir, logger: false });
    assert.equal(logged.length, 3);
    assert.ok(!logged[2].includes("secret-looking-garbage"));
  } finally {
    console.warn = original;
  }
});

test("a well-formed but unsigned token is refused", async () => {
  const loaded = load();
  const forged = `i${deflateRawSync(Buffer.from(JSON.stringify(["high", 0, 0, "title", "summary", "next", "owner", "window", null]))).toString("base64url")}`;
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

test("two plugin instances on one state dir sign and verify each other's tokens", async () => {
  const stateDir = newStateDir();
  const a = load(baseConfig, { stateDir });
  const b = load(baseConfig, { stateDir });
  const fromA = pick(blocksOf(postCard(a)), "High");
  const fromB = pick(blocksOf(postCard(b)), "Low");
  const clickB = fakeClick({ value: fromA });
  await b.interactive.handler(clickB.ctx);
  assert.equal(clickB.calls.edits.length, 1);
  const clickA = fakeClick({ value: fromB });
  await a.interactive.handler(clickA.ctx);
  assert.equal(clickA.calls.edits.length, 1);
  assert.deepEqual([...a.warnings, ...b.warnings], []);
  // A different state dir is a different key: its tokens fail closed.
  await refused(load(baseConfig), fakeClick({ value: fromA }));
});

test("a restart (a new instance) verifies old tokens, and the key file is created once", async () => {
  const stateDir = newStateDir();
  const before = load(baseConfig, { stateDir });
  const value = pick(blocksOf(postCard(before)), "High");
  const stored = readFileSync(keyPath(stateDir), "utf8");
  assert.equal(Buffer.from(stored, "base64url").length, 32);
  const after = load(baseConfig, { stateDir });
  assert.equal(readFileSync(keyPath(stateDir), "utf8"), stored);
  const click = fakeClick({ value });
  await after.interactive.handler(click.ctx);
  assert.equal(click.calls.edits.length, 1);
});

test("the key file is mode 0600 in a 0700 directory", () => {
  const stateDir = newStateDir();
  load(baseConfig, { stateDir });
  assert.equal(statSync(keyPath(stateDir)).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, "plugins", "livex-slack-summary")).mode & 0o777, 0o700);
});

test("a corrupt key file disables buttons, is not overwritten, and logs", () => {
  const corrupt = ["", "short", `${"A".repeat(42)}B`, "!".repeat(43), Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url")];
  for (const content of corrupt) {
    const stateDir = newStateDir();
    load(baseConfig, { stateDir });
    writeFileSync(keyPath(stateDir), content);
    const loaded = load(baseConfig, { stateDir });
    assert.equal(loaded.registrations.length, 0, JSON.stringify(content));
    assert.equal(buttonsOf(blocksOf(postCard(loaded))).length, 0);
    assert.equal(readFileSync(keyPath(stateDir), "utf8"), content);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /buttons disabled/u);
  }
});

test("buttons are disabled and logged when no state dir resolves or the dir is unusable", () => {
  const original = process.env.OPENCLAW_STATE_DIR;
  try {
    delete process.env.OPENCLAW_STATE_DIR;
    const throwing = () => {
      throw new Error("no");
    };
    for (const runtime of [{}, { state: {} }, { state: { resolveStateDir: () => "" } }, { state: { resolveStateDir: throwing } }]) {
      const loaded = load(baseConfig, { runtime });
      assert.equal(loaded.registrations.length, 0);
      assert.equal(buttonsOf(blocksOf(postCard(loaded))).length, 0);
      assert.equal(loaded.warnings.length, 1);
    }
    // OPENCLAW_STATE_DIR is the fallback when the runtime cannot resolve one.
    const envDir = newStateDir();
    process.env.OPENCLAW_STATE_DIR = envDir;
    const viaEnv = load(baseConfig, { runtime: {} });
    assert.equal(viaEnv.registrations.length, 1);
    assert.equal(statSync(keyPath(envDir)).mode & 0o777, 0o600);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = original;
  }
  // A state dir whose plugin directory cannot be created (a file is in the way).
  const stateDir = newStateDir();
  writeFileSync(join(stateDir, "plugins"), "not a directory");
  const blocked = load(baseConfig, { stateDir });
  assert.equal(blocked.registrations.length, 0);
  assert.equal(blocked.warnings.length, 1);
});

test("without buttons configured no key file is created", () => {
  const stateDir = newStateDir();
  load({}, { stateDir });
  assert.throws(() => statSync(keyPath(stateDir)), { code: "ENOENT" });
});

const coreUrl = new URL("./core.mjs", import.meta.url).href;
const runChild = (code, ...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });

test("concurrent creation from separate processes ends with the same key", async () => {
  const stateDir = newStateDir();
  const code = `import { loadSigningKey } from ${JSON.stringify(coreUrl)};
const r = loadSigningKey(process.argv[1]); process.stdout.write(r.key ? r.key.toString("base64url") : "ERR:" + r.error);`;
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(code, stateDir)));
  assert.equal(new Set(results).size, 1, results.join(","));
  assert.equal(results[0], readFileSync(keyPath(stateDir), "utf8"));
  assert.equal(Buffer.from(results[0], "base64url").length, 32);
  // Two instances in one process agree too.
  const dir = newStateDir();
  assert.deepEqual(loadSigningKey(dir).key, loadSigningKey(dir).key);
});

test("a reader that finds a half-written key file waits for the writer instead of calling it corrupt", async () => {
  const stateDir = newStateDir();
  const full = Buffer.alloc(32, 7).toString("base64url");
  loadSigningKey(stateDir);
  writeFileSync(keyPath(stateDir), full.slice(0, 10));
  // The writer finishes in another process while this one blocks inside loadSigningKey.
  const writer = runChild(
    `await new Promise((r) => setTimeout(r, 60)); (await import("node:fs")).writeFileSync(process.argv[1], process.argv[2]);`,
    keyPath(stateDir),
    full,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loadSigningKey(stateDir, { raceWaitMs: 1500 }).key?.toString("base64url"), full);
  await writer;
});
