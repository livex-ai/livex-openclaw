import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { classifyEnvelope } from "./core.mjs";

const dir = new URL("../../agents/debugger/", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, dir), "utf8");
const skill = read("skills/investigate-alerts/SKILL.md");

test("the skill's example envelope is a valid V3 card in both plugins", async () => {
  const line = skill.split("\n").map((l) => l.trim()).find((l) => l.startsWith('{"title"'));
  const text = `LIVEX_ALERT_SUMMARY_V3\n${line}\n\nFull report.`;
  assert.ok(classifyEnvelope(text).card);
  const lite = await import("../livex-investigations-lite/core.mjs");
  assert.ok(lite.readSummaryEnvelope(text).record);
});

test("instructions no longer ask the model for a priority", () => {
  for (const file of ["AGENTS.md", "skills/investigate-alerts/SKILL.md"]) {
    const text = read(file);
    assert.doesNotMatch(text, /LIVEX_ALERT_SUMMARY_V2|Priority unknown|provisional/u, file);
    assert.match(text, /LIVEX_ALERT_SUMMARY_V3/u, file);
  }
});

test("every playbook has the sections the table depends on and valid pattern ids", () => {
  const refs = "skills/investigate-alerts/references/";
  for (const name of ["gke-application-errors", "phone-call-notes", "error-digest-categories", "low-conversation-volume", "log-match-alerts"]) {
    const text = read(`${refs}${name}.md`);
    for (const heading of ["## Client effect check", "## Sustained check", "## Known patterns", "## Alert severity"]) assert.ok(text.includes(heading), `${name}: ${heading}`);
    assert.doesNotMatch(text, /^## Severity$/mu, name);
    for (const [, id] of text.matchAll(/pattern:([^\s|`)]+)/gu)) assert.match(id, /^[a-z0-9-]{3,60}$/u, `${name}: ${id}`);
  }
});

test("the playbooks' Known patterns tables and the shipped policy's knownPatterns list the same ids", () => {
  const refs = "skills/investigate-alerts/references/";
  const inTables = new Set();
  for (const name of fs.readdirSync(new URL(refs, dir)).filter((f) => f.endsWith(".md"))) {
    const text = read(`${refs}${name}`);
    const start = text.indexOf("## Known patterns");
    if (start < 0) continue;
    const rest = text.slice(start + 1);
    const section = rest.slice(0, rest.search(/\n## /u) < 0 ? undefined : rest.search(/\n## /u));
    for (const [, id] of section.matchAll(/^\|\s*`pattern:([^`]+)`/gmu)) inTables.add(id);
  }
  const shipped = JSON.parse(fs.readFileSync(new URL("../../config/priority-policy.json", import.meta.url), "utf8"));
  assert.ok(inTables.size > 0);
  assert.deepEqual([...inTables].sort(), [...shipped.knownPatterns].sort());
});
