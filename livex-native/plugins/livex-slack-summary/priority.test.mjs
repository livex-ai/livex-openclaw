import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY, computePriority, loadPolicy, validKnownRef } from "./priority.mjs";

const base = { alertClass: "gke-application-errors", service: "chat-engine", alertSeverity: "error", sustained: false, known: "no", sampleChecked: 5, sampleAffected: 0, scope: "unknown", traffic: "live", clientEffectVerified: true };
const ok = { ok: 2, degraded: false, outcomes: 3 };
const rate = (f, r = ok, p = DEFAULT_POLICY) => computePriority({ ...base, ...f }, p, r);

test("shipped policy file equals the built-in default", () => {
  const shipped = JSON.parse(fs.readFileSync(new URL("../../config/priority-policy.json", import.meta.url), "utf8"));
  assert.deepEqual(shipped, DEFAULT_POLICY);
});

test("every row of the starting table", () => {
  assert.deepEqual(pick(rate({ sampleAffected: 1, traffic: "test" })), ["low", "test-traffic", "yes"]);
  assert.deepEqual(pick(rate({ sampleAffected: 3 })), ["high", "live-broad", "yes"]);            // 3 of 5 >= half
  assert.deepEqual(pick(rate({ sampleAffected: 1, scope: "multiple" })), ["high", "live-broad", "yes"]);
  assert.deepEqual(pick(rate({ sampleAffected: 1, scope: "single" })), ["medium", "live-narrow", "yes"]);
  assert.deepEqual(pick(rate({ clientEffectVerified: false })), ["medium", "unverified-user-facing", "unverified"]);
  assert.deepEqual(pick(rate({ clientEffectVerified: false, service: "embedding-server" })), ["low", "unverified-background", "unverified"]);
  assert.deepEqual(pick(rate({ known: "harmless", knownRef: "pattern:wyze-malformed-agent-id" })), ["low", "known-discount", "no"]);
  assert.deepEqual(pick(rate({ sustained: true })), ["medium", "recurring-error", "no"]);
  assert.deepEqual(pick(rate({})), ["low", "no-impact", "no"]);
});
const pick = (r) => [r.priority, r.ruleId, r.clientEffect];

test("a failed or capped read never yields 'no'; no read at all is unverified", () => {
  assert.equal(rate({}, { ok: 2, degraded: true }).clientEffect, "unverified");
  assert.equal(rate({ sampleAffected: 4 }, { ok: 0, degraded: false }).clientEffect, "unverified");
  assert.equal(rate({ sampleChecked: 2 }).clientEffect, "unverified"); // below minSample 3
});

test("'no' needs at least minSample outcome reads; a missing count is 0", () => {
  const few = rate({}, { ok: 5, degraded: false, outcomes: 2 });
  assert.equal(few.clientEffect, "unverified");
  assert.equal(few.fewOutcomes, true);
  assert.equal(rate({}, { ok: 5, degraded: false }).clientEffect, "unverified");
  assert.equal(rate({}, { ok: 5, degraded: false, outcomes: 3 }).clientEffect, "no");
  assert.equal(rate({}, { ok: 5, degraded: true, outcomes: 3 }).fewOutcomes, false);
  // An affected sample is "yes" whatever the outcome count.
  assert.equal(rate({ sampleAffected: 1 }, { ok: 1, degraded: false, outcomes: 0 }).clientEffect, "yes");
});

test("known issue: ongoing keeps the level, known-but-affected raises, bad refs count as no", () => {
  assert.equal(rate({ sampleAffected: 3, known: "ongoing", knownRef: "LX-12525" }).priority, "high");
  const lifted = rate({ sampleAffected: 1, traffic: "test", known: "fixed", knownRef: "LX-1" });
  assert.equal(lifted.priority, "medium");
  assert.ok(lifted.notes.includes("marked known but users still affected"));
  const bad = rate({ known: "harmless", knownRef: "see the log line" });
  assert.equal(bad.known, "no");
  assert.equal(bad.ruleId, "no-impact");
  assert.ok(bad.notes.includes("known reference not accepted"));
});

test("validKnownRef accepts only the three kinds, and harmless only a pattern", () => {
  const P = DEFAULT_POLICY;
  assert.equal(validKnownRef("ongoing", "LX-12525", P), true);
  assert.equal(validKnownRef("fixed", "https://livexai.slack.com/archives/C079BU33H0W/p1794620397634959", P), true);
  assert.equal(validKnownRef("harmless", "pattern:wyze-malformed-agent-id", P), true);
  assert.equal(validKnownRef("harmless", "LX-12525", P), false);
  for (const ref of ["<!channel>", "<https://evil.example|LX-1>", "@here", "", undefined, 42]) assert.equal(validKnownRef("ongoing", ref, P), false);
});

test("validKnownRef: a pattern must be listed and a Slack link must be on a listed workspace", () => {
  const P = DEFAULT_POLICY;
  assert.equal(validKnownRef("harmless", "pattern:made-up-thing", P), false);
  assert.equal(validKnownRef("ongoing", "https://otherco.slack.com/archives/C079BU33H0W/p1794620397634959", P), false);
  // An empty or missing workspace list accepts any workspace; a missing pattern list accepts none.
  const open = { ...P, slackWorkspaces: [] };
  assert.equal(validKnownRef("ongoing", "https://otherco.slack.com/archives/C079BU33H0W/p1794620397634959", open), true);
  const { slackWorkspaces, knownPatterns, ...bare } = P;
  assert.equal(validKnownRef("ongoing", "https://otherco.slack.com/archives/C079BU33H0W/p1794620397634959", bare), true);
  assert.equal(validKnownRef("harmless", "pattern:wyze-malformed-agent-id", bare), false);
  const made = rate({ known: "harmless", knownRef: "pattern:made-up-thing" });
  assert.deepEqual([made.known, made.ruleId], ["no", "no-impact"]);
  const foreign = rate({ known: "fixed", knownRef: "https://otherco.slack.com/archives/C079BU33H0W/p1794620397634959" });
  assert.equal(foreign.known, "no");
  assert.ok(foreign.notes.includes("known reference not accepted"));
});

test("unlisted class and service are user-facing", () => {
  assert.equal(rate({ alertClass: "unclassified", service: "none", clientEffectVerified: false }).userFacing, true);
});

test("loadPolicy falls back to the default and warns once; it never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  const cases = { missing: undefined, notJson: "{", badKey: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { mood: ["bad"] }, priority: "low", note: "n" }] }), badPriority: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: {}, priority: "unknown", note: "n" }] }), badCoverage: JSON.stringify({ ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.filter((r) => r.id !== "no-impact") }), badRaiseAtLeast: JSON.stringify({ ...DEFAULT_POLICY, raise: [{ id: "r", when: { clientEffect: ["yes"] }, atLeast: "urgent", note: "n" }] }), badRaiseKey: JSON.stringify({ ...DEFAULT_POLICY, raise: [{ id: "r", when: { mood: ["bad"] }, atLeast: "medium", note: "n" }] }),
    badRaiseValue: JSON.stringify({ ...DEFAULT_POLICY, raise: [{ id: "r", when: { clientEffect: ["maybe"] }, atLeast: "medium", note: "n" }] }),
    badEffectValue: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { clientEffect: ["sometimes"] }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    badTrafficValue: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { traffic: ["staging"] }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    badKnownValue: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { known: ["maybe"] }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    badSeverityValue: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { alertSeverity: ["critical"] }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    enumAsBoolean: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { traffic: true }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    boolAsArray: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { broad: [true] }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    boolAsString: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { sustained: "yes" }, priority: "low", note: "n" }, ...DEFAULT_POLICY.rules] }),
    duplicateId: JSON.stringify({ ...DEFAULT_POLICY, rules: [DEFAULT_POLICY.rules[0], ...DEFAULT_POLICY.rules] }),
    badPatternList: JSON.stringify({ ...DEFAULT_POLICY, knownPatterns: ["Bad Id"] }),
    patternListNotArray: JSON.stringify({ ...DEFAULT_POLICY, knownPatterns: "wyze-malformed-agent-id" }),
    badWorkspace: JSON.stringify({ ...DEFAULT_POLICY, slackWorkspaces: ["livexai.slack.com"] }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.json`);
    if (text !== undefined) fs.writeFileSync(file, text);
    const warned = [];
    assert.deepEqual(loadPolicy(file, (m) => warned.push(m)), DEFAULT_POLICY, name);
    assert.equal(warned.length, 1, name);
    assert.match(warned[0], /^livex-slack-summary: priority policy /);
  }
  assert.deepEqual(loadPolicy(undefined, () => assert.fail("no warning without a path")), DEFAULT_POLICY);
  const custom = { ...DEFAULT_POLICY, minSample: 5 };
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify(custom));
  assert.equal(loadPolicy(path.join(dir, "ok.json"), () => {}).minSample, 5);
});

test("a policy with the default rules in another order is accepted and rated by that order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  const byId = Object.fromEntries(DEFAULT_POLICY.rules.map((r) => [r.id, r]));
  const order = ["test-traffic", "live-broad", "live-narrow", "unverified-user-facing", "unverified-background", "known-discount", "no-impact", "recurring-error"];
  const file = path.join(dir, "reordered.json");
  fs.writeFileSync(file, JSON.stringify({ ...DEFAULT_POLICY, rules: order.map((id) => byId[id]) }));
  const reordered = loadPolicy(file, () => assert.fail("a reordered default policy is valid"));
  assert.deepEqual(reordered.rules.map((r) => r.id), order);
  assert.deepEqual(pick(rate({ sustained: true })), ["medium", "recurring-error", "no"]);
  assert.deepEqual(pick(rate({ sustained: true }, ok, reordered)), ["low", "no-impact", "no"]);
});

test("traffic unknown is rated as live, not test", () => {
  assert.deepEqual(pick(rate({ sampleAffected: 1, scope: "single", traffic: "unknown" })), ["medium", "live-narrow", "yes"]);
});

test("an empty sample is unverified and does not divide by zero", () => {
  assert.deepEqual(pick(rate({ sampleChecked: 0, sampleAffected: 0 })), ["medium", "unverified-user-facing", "unverified"]);
});

test("the default policy cannot be mutated through a fallback", () => {
  const first = loadPolicy(undefined, () => {});
  assert.throws(() => { first.minSample = 99; }, TypeError);
  assert.throws(() => { first.rules[0].priority = "high"; }, TypeError);
  assert.equal(loadPolicy(undefined, () => {}).minSample, 3);
  assert.equal(DEFAULT_POLICY.rules[0].priority, "low");
});
