import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { classifyEnvelope } from "./core.mjs";
import { DEFAULT_POLICY, computePriority } from "./priority.mjs";

const alerts = JSON.parse(fs.readFileSync(new URL("./replay/alerts.json", import.meta.url), "utf8"));

test("the replay set is exactly the five named alerts, each well-formed", () => {
  assert.deepEqual(alerts.map((a) => a.name), [
    "api-gateway errors, 15 in 10 min",
    "language-detection timeouts (109 in digest)",
    "phone call notes missing",
    "conversation-avatar ElevenLabs errors",
    "conversation-avatar silent session",
  ]);
  for (const a of alerts) {
    assert.ok(typeof a.name === "string" && a.name.length > 0);
    assert.ok(typeof a.thread === "string" && a.thread.length > 0, a.name);
    assert.equal(typeof a.ownerConfirmed, "boolean", a.name);
  }
});

for (const a of alerts) {
  test(`replay: ${a.name}`, () => {
    assert.equal(computePriority(a.facts, DEFAULT_POLICY, a.reads).priority, a.expected);
  });
  test(`replay envelope: ${a.name}`, () => {
    const fields = {
      title: `Replay ${a.name}`,
      signature: `replay | ${a.name} | check`,
      ...a.facts,
      summary: "Replay summary of the alert.",
      nextAction: "Replay next action.",
      owner: "Unassigned",
      checkedWindow: "2026-11-14 10:00–10:10 UTC",
    };
    const text = `LIVEX_ALERT_SUMMARY_V3\n${JSON.stringify(fields)}\n\nFull report.`;
    const result = classifyEnvelope(text, undefined, { policy: DEFAULT_POLICY, reads: a.reads });
    assert.ok(result.card, `envelope rejected: ${result.reason}`);
    assert.equal(result.card.priority, a.expected);
  });
}

test("every replay entry is owner-confirmed (strict mode only)", { skip: process.env.LIVEX_REPLAY_REQUIRE_CONFIRMED !== "1" }, () => {
  const pending = alerts.filter((a) => a.ownerConfirmed !== true).map((a) => a.name);
  assert.deepEqual(pending, [], `not owner-confirmed: ${pending.join("; ")}`);
});
