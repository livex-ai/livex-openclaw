import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { DEFAULT_POLICY, computePriority } from "./priority.mjs";

const alerts = JSON.parse(fs.readFileSync(new URL("./replay/alerts.json", import.meta.url), "utf8"));

test("replay set is not empty", () => {
  assert.ok(alerts.length >= 5);
});

for (const a of alerts) {
  test(`replay: ${a.name}`, () => {
    assert.equal(computePriority(a.facts, DEFAULT_POLICY, a.reads).priority, a.expected);
  });
}

test("every replay entry is owner-confirmed (strict mode only)", { skip: process.env.LIVEX_REPLAY_REQUIRE_CONFIRMED !== "1" }, () => {
  const pending = alerts.filter((a) => a.ownerConfirmed !== true).map((a) => a.name);
  assert.deepEqual(pending, [], `not owner-confirmed: ${pending.join("; ")}`);
});
