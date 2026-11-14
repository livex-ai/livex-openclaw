import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY, computePriority, loadPolicy, validKnownRef } from "./priority.mjs";

const base = { alertClass: "gke-application-errors", service: "chat-engine", alertSeverity: "error", sustained: false, known: "no", sampleChecked: 5, sampleAffected: 0, scope: "unknown", traffic: "live", clientEffectVerified: true };
const ok = { ok: 2, degraded: false };
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
  assert.deepEqual(pick(rate({ known: "harmless", knownRef: "pattern:client-cancel" })), ["low", "known-discount", "no"]);
  assert.deepEqual(pick(rate({ sustained: true })), ["medium", "recurring-error", "no"]);
  assert.deepEqual(pick(rate({})), ["low", "no-impact", "no"]);
});
const pick = (r) => [r.priority, r.ruleId, r.clientEffect];

test("a failed or capped read never yields 'no'; no read at all is unverified", () => {
  assert.equal(rate({}, { ok: 2, degraded: true }).clientEffect, "unverified");
  assert.equal(rate({ sampleAffected: 4 }, { ok: 0, degraded: false }).clientEffect, "unverified");
  assert.equal(rate({ sampleChecked: 2 }).clientEffect, "unverified"); // below minSample 3
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
  assert.equal(validKnownRef("ongoing", "LX-12525"), true);
  assert.equal(validKnownRef("fixed", "https://livexai.slack.com/archives/C079BU33H0W/p1794620397634959"), true);
  assert.equal(validKnownRef("harmless", "pattern:client-cancel"), true);
  assert.equal(validKnownRef("harmless", "LX-12525"), false);
  for (const ref of ["<!channel>", "<https://evil.example|LX-1>", "@here", "", undefined, 42]) assert.equal(validKnownRef("ongoing", ref), false);
});

test("unlisted class and service are user-facing", () => {
  assert.equal(rate({ alertClass: "unclassified", service: "none", clientEffectVerified: false }).userFacing, true);
});

test("loadPolicy falls back to the default and warns once; it never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  const cases = { missing: undefined, notJson: "{", badKey: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: { mood: ["bad"] }, priority: "low", note: "n" }] }), badPriority: JSON.stringify({ ...DEFAULT_POLICY, rules: [{ id: "x", when: {}, priority: "unknown", note: "n" }] }) };
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
