// Applies patch-slack-attachments.mjs to the real @openclaw/slack@2026.10.5 package.
// Set LIVEX_SLACK_PACKAGE_DIR to an extracted stock package directory (the folder that
// contains dist/), e.g. `npm pack @openclaw/slack@2026.10.5 && tar -xzf *.tgz`; without it
// these tests are skipped. The image build verifies the tarball integrity, not this test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITS, patchSlackAttachments } from "./patch-slack-attachments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stock = process.env.LIVEX_SLACK_PACKAGE_DIR;
const skip = stock ? false : "set LIVEX_SLACK_PACKAGE_DIR to an extracted @openclaw/slack@2026.10.5 package";
const FILES = [
  "monitor-CNECe8FK.mjs",
  "send-CyRH2z7u.mjs",
  "replies-BNr7i3d0.mjs",
  "outbound-adapter-CEh2K9pB.mjs",
  "channel-C6Y0ZA9K.mjs",
  "action-runtime-DtOIVezL.mjs",
  "actions-Ch4O8XbW.mjs",
];
const setup = (dir) => path.join(dir, "dist/.setup");

function copyPackage() {
  // Only the patched bundles: the patches read nothing else.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "livex-slack-attachments-")), "package");
  fs.mkdirSync(setup(dir), { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(setup(stock), file), path.join(setup(dir), file));
  return dir;
}

const run = (script, dir) => execFileSync(process.execPath, [path.join(here, script), dir], { stdio: "pipe" });
const read = (dir, file) => fs.readFileSync(path.join(setup(dir), file), "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const stockDigests = (dir) => Object.fromEntries(FILES.map((file) => [file, [sha(read(dir, file))]]));

function applyBoth() {
  const dir = copyPackage();
  run("patch-slack-navigation.mjs", dir); // the image build applies it first
  run("patch-slack-attachments.mjs", dir);
  return dir;
}

test("patches the navigation-patched dist and all seven patched files pass node --check", { skip }, () => {
  const dir = applyBoth();
  for (const file of FILES) {
    execFileSync(process.execPath, ["--check", path.join(setup(dir), file)]);
    assert.notEqual(read(dir, file), fs.readFileSync(path.join(setup(stock), file), "utf8"), file);
  }
  // The navigation backport survived.
  assert.match(read(dir, "monitor-CNECe8FK.mjs"), /isSlackNavigationButton/u);
});

test("also applies to the stock dist without the navigation backport", { skip }, () => {
  const dir = copyPackage();
  run("patch-slack-attachments.mjs", dir);
  for (const file of FILES) {
    execFileSync(process.execPath, ["--check", path.join(setup(dir), file)]);
    assert.notEqual(read(dir, file), fs.readFileSync(path.join(setup(stock), file), "utf8"), file);
  }
});

test("refuses to apply twice and leaves the files untouched", { skip }, () => {
  const dir = applyBoth();
  const before = FILES.map((file) => read(dir, file));
  assert.throws(() => run("patch-slack-attachments.mjs", dir), (error) => /already applied/u.test(String(error.stderr)));
  assert.deepEqual(FILES.map((file) => read(dir, file)), before);
});

test("refuses an unexpected bundle, a missing anchor and an ambiguous anchor", { skip }, () => {
  const unexpected = copyPackage();
  fs.appendFileSync(path.join(setup(unexpected), "send-CyRH2z7u.mjs"), "\n// drift\n");
  assert.throws(() => patchSlackAttachments(setup(unexpected)), /Unexpected send-CyRH2z7u\.mjs/u);

  // Every exact anchor of every edit must be required once: removing it or duplicating it aborts.
  const dir = copyPackage();
  let cases = 0;
  for (const [file, edits] of Object.entries(EDITS)) {
    const original = read(dir, file);
    for (const { anchor } of edits) {
      for (const mutated of [original.replace(anchor, "// removed"), `${original}\n${anchor}`]) {
        fs.writeFileSync(path.join(setup(dir), file), mutated);
        // Re-pin the mutated file's digest so the anchor check is what fails.
        assert.throws(() => patchSlackAttachments(setup(dir), stockDigests(dir)), /missing or ambiguous/u, `${file}: ${anchor.slice(0, 60)}`);
        cases += 1;
      }
    }
    fs.writeFileSync(path.join(setup(dir), file), original);
  }
  assert.equal(cases, 2 * Object.values(EDITS).flat().length);
});

test("a failed patch writes nothing (the CLI validates every file first)", { skip }, () => {
  const dir = copyPackage();
  fs.appendFileSync(path.join(setup(dir), "outbound-adapter-CEh2K9pB.mjs"), "\n// drift\n");
  const before = FILES.map((file) => read(dir, file));
  assert.throws(() => run("patch-slack-attachments.mjs", dir));
  assert.deepEqual(FILES.map((file) => read(dir, file)), before);
});

// The patched post-message payload builder, evaluated in isolation (the bundle itself needs
// the OpenClaw runtime to import).
function loadPostPayloadBuilder(dir) {
  const source = read(dir, "send-CyRH2z7u.mjs");
  const start = source.indexOf("function livexSanitizeSlackAttachments(");
  const end = source.indexOf("//#endregion", source.indexOf("function buildSlackPostMessagePayload("));
  assert.ok(start > 0 && end > start);
  return new Function(`${source.slice(start, end)}\nreturn { buildSlackPostMessagePayload, livexSanitizeSlackAttachments };`)();
}

function loadMonitorSanitizer(dir) {
  const source = read(dir, "monitor-CNECe8FK.mjs");
  const start = source.indexOf("function livexSanitizeSlackAttachments(");
  const end = source.indexOf("async function updateSlackInteractionMessage(");
  return new Function(`${source.slice(start, end)}\nreturn livexSanitizeSlackAttachments;`)();
}

const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });
const attachment = { color: "#D92D20", fallback: "fallback", blocks: [section("a"), section("b")] };
const post = (extra) => ({ channelId: "C1", text: "t", blocks: [section("title")], ...extra });

test("the patched chat.postMessage payload carries a valid attachment next to blocks", { skip }, () => {
  const { buildSlackPostMessagePayload } = loadPostPayloadBuilder(applyBoth());
  const payload = buildSlackPostMessagePayload(post({ attachments: [attachment], threadTs: "1.2" }));
  assert.deepEqual(payload.attachments, [attachment]);
  assert.deepEqual(payload.blocks, [section("title")]);
  assert.equal(payload.thread_ts, "1.2");
  // Without attachments the payload is exactly the stock shape.
  assert.equal("attachments" in buildSlackPostMessagePayload(post({})), false);
});

test("attachments are dropped unless they are one {color, blocks, fallback} attachment next to blocks", { skip }, () => {
  const dir = applyBoth();
  const { buildSlackPostMessagePayload } = loadPostPayloadBuilder(dir);
  const sanitizers = [loadPostPayloadBuilder(dir).livexSanitizeSlackAttachments, loadMonitorSanitizer(dir)];
  const bad = [
    [attachment, attachment],
    [],
    "x",
    { ...attachment },
    [{ ...attachment, text: "legacy text" }],
    [{ ...attachment, title: "t" }],
    [{ ...attachment, color: "red" }],
    [{ ...attachment, color: "#D92D2" }],
    [{ ...attachment, color: "#D92D20FF" }],
    [{ ...attachment, color: 0xd92d20 }],
    [{ ...attachment, fallback: 5 }],
    [{ ...attachment, blocks: undefined }],
    [{ ...attachment, blocks: [] }],
    [{ ...attachment, blocks: Array.from({ length: 11 }, () => section("x")) }],
    [{ ...attachment, blocks: ["not a block"] }],
    [{ ...attachment, blocks: [{ text: "no type" }] }],
    [null],
    [[attachment]],
  ];
  for (const value of bad) {
    for (const sanitize of sanitizers) assert.equal(sanitize(value), undefined, JSON.stringify(value));
    assert.equal("attachments" in buildSlackPostMessagePayload(post({ attachments: value })), false, JSON.stringify(value));
  }
  for (const sanitize of sanitizers) {
    assert.deepEqual(sanitize([attachment]), [attachment]);
    assert.deepEqual(sanitize([{ blocks: [section("only")] }]), [{ blocks: [section("only")] }]);
    assert.deepEqual(sanitize([{ ...attachment, blocks: Array.from({ length: 10 }, () => section("x")) }])[0].blocks.length, 10);
  }
  // The sanitizer copies only known keys and never passes the caller's object through.
  assert.notEqual(sanitizers[0]([attachment])[0], attachment);
});

test("attachments never ride on a message without blocks (text chunks)", { skip }, () => {
  const { buildSlackPostMessagePayload } = loadPostPayloadBuilder(applyBoth());
  assert.equal("attachments" in buildSlackPostMessagePayload({ channelId: "C1", text: "t", attachments: [attachment] }), false);
  assert.equal("attachments" in buildSlackPostMessagePayload({ channelId: "C1", text: "t", blocks: [], attachments: [attachment] }), false);
});

// The message-tool edit path: the real patched editSlackRenderedMessage with its collaborators stubbed.
function loadEditMessage(dir) {
  const source = read(dir, "actions-Ch4O8XbW.mjs");
  const start = source.indexOf("function livexSanitizeSlackAttachments(");
  const end = source.indexOf("async function deleteSlackMessage(");
  assert.ok(start > 0 && end > start);
  const updates = [];
  const stubs = {
    getClient: async () => ({ chat: { update: async (payload) => void updates.push(payload) } }),
    validateSlackBlocksArray: (blocks) => blocks,
    buildSlackEditTextPayload: (content) => content,
    hasSlackNativeDataBlock: () => false,
    appendSlackNativeDataFallbackText: (text) => text,
    countSlackTextUtf8Bytes: (text) => Buffer.byteLength(text),
    truncateSlackTextByUtf8Bytes: (text) => text,
    SLACK_EDIT_TEXT_MAX_BYTES: 4000,
  };
  const names = Object.keys(stubs);
  const factory = new Function(...names, `${source.slice(start, end)}\nreturn editSlackRenderedMessage;`);
  return { edit: factory(...names.map((name) => stubs[name])), updates };
}

test("the patched edit path sends the sanitized attachment, else [] so no stale bar survives", { skip }, async () => {
  const { edit, updates } = loadEditMessage(applyBoth());
  const blocks = [section("title")];
  await edit("C1", "1.2", "text", { blocks, attachments: [attachment] });
  await edit("C1", "1.2", "text", { blocks });
  await edit("C1", "1.2", "text", { blocks, attachments: [attachment, attachment] });
  await edit("C1", "1.2", "text", { blocks, attachments: [{ ...attachment, color: "red" }] });
  await edit("C1", "1.2", "text", { blocks, attachments: [{ ...attachment, text: "legacy" }] });
  assert.deepEqual(updates[0].attachments, [attachment]);
  assert.deepEqual(updates[0].blocks, blocks);
  for (const update of updates.slice(1)) assert.deepEqual(update.attachments, []);
  // A text-only edit is left exactly as stock sent it.
  await edit("C1", "1.2", "text only", { attachments: [attachment] });
  assert.equal("attachments" in updates.at(-1), false);
});

test("the param chain forwards livexAttachments from the tool edit to the edit call", { skip }, () => {
  const dir = applyBoth();
  // channel: the edit action passes the guard's param as `attachments`, and only when it is an array.
  assert.match(read(dir, "channel-C6Y0ZA9K.mjs"), /\.\.\.Array\.isArray\(actionParams\.livexAttachments\) \? \{ attachments: actionParams\.livexAttachments \} : \{\}/u);
  // action runtime: editMessage hands `attachments` to editSlackMessage's options.
  assert.match(read(dir, "action-runtime-DtOIVezL.mjs"), /\.\.\.writeOpts,\n\s+blocks,\n\s+\.\.\.Array\.isArray\(params\.attachments\)/u);
  // The tool's own media `attachments` param is never read by the edit action.
  assert.doesNotMatch(read(dir, "channel-C6Y0ZA9K.mjs"), /actionParams\.attachments/u);
});
