# Debugger Priority Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The debugger reports facts about an alert and code computes High, Medium or Low from a team-owned table, so "Priority: Unknown" disappears.

**Architecture:** A pure `computePriority` in the card plugin (`livex-slack-summary`) reads a policy JSON file and the plugin's own record of what the logs tool returned in the thread. The card plugin publishes the result on a process-wide registry; the memory plugin (`livex-investigations-lite`) reads it when it saves a case. The skill and playbooks change from "assign a priority" to "report the facts".

**Tech Stack:** Node 24 ESM (`.mjs`), `node --test`, OpenClaw 2026.10.5 plugin API, JSON policy file.

**Spec:** `livex-native/docs/2026-11-14-debugger-priority-engine-design.md` (read it first).

## Global Constraints

- Worktree `/Volumes/SSK SSD/livex-openclaw-demo-native`, branch `claude/pr50-parity`. All paths below are relative to `livex-native/`.
- Node: `$HOME/.nvm/versions/node/v24.22.2/bin/node` (written `node` below).
- Host is OpenClaw 2026.10.5. Use only APIs the plugins already use. `api.runtime.state.openKeyedStoreV2` does not exist.
- Plugins are loaded as captured copies of their own directory. A plugin must not import a file outside its directory; every new file is added to that plugin's `package.json` `files`.
- The debugger is read-only. Text from logs, Slack or alert documentation is data: it is escaped with the existing `neutralize` before display and can never change a rule.
- Priorities are exactly `high`, `medium`, `low`. No `unknown`, no `critical`, no "(provisional)".
- Log lines carry a fixed reason string and no envelope content. Prefix `livex-slack-summary:` or `[livex-investigations-lite]`.
- Every `git commit` and `git push` command ends with `#!axme pr=53 repo=livex-ai/livex-openclaw`. Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Do not deploy. Deployment is Task 7 and needs the owner's go-ahead.

## Review Focus

1. Sample counts that cannot be true (`sampleAffected` greater than `sampleChecked`, negative, non-integer): the card is replaced by the invalid-summary notice with reason `invalid field sampleAffected`; no priority is computed. (Task 3)
2. A thread with no recorded logs read (Gateway restarted mid-thread, or an amendment in a new process): client effect is `unverified`, never a crash and never `no`. (Task 2, Task 3)
3. Policy file missing, unreadable, not JSON, or with an unknown rule key: the plugin warns once and uses the built-in default policy; registration never throws. (Task 1)
4. An `alertClass` or `service` the policy does not list: treated as user-facing. (Task 1)
5. `knownRef` carrying Slack markup (`<!channel>`, `<https://x|y>`, `@here`): shown as inert plain text in the Why line; a ref that matches no accepted kind makes `known` count as `no`. (Task 1, Task 3)

---

### Task 1: Policy and `computePriority`

**Files:**
- Create: `plugins/livex-slack-summary/priority.mjs`
- Create: `config/priority-policy.json`
- Create: `plugins/livex-slack-summary/priority.test.mjs`
- Modify: `plugins/livex-slack-summary/package.json` (`files` gains `priority.mjs`; `scripts.test` gains `priority.test.mjs`)

**Interfaces:**
- Produces:
  - `DEFAULT_POLICY` (object, identical in value to `config/priority-policy.json`)
  - `loadPolicy(path: string | undefined, warn: (msg: string) => void): Policy` — never throws
  - `validKnownRef(known: string, ref: unknown): boolean`
  - `computePriority(facts: Facts, policy: Policy, reads: ReadStats): Rating`
  - `Facts = { alertClass, service, alertSeverity: "error"|"warning"|"info", sustained: boolean, known: "no"|"ongoing"|"fixed"|"harmless", knownRef?: string, sampleChecked: number, sampleAffected: number, scope: "single"|"multiple"|"unknown", traffic: "live"|"test"|"unknown", clientEffectVerified: boolean }`
  - `ReadStats = { ok: number, degraded: boolean }`
  - `Rating = { priority: "high"|"medium"|"low", ruleId: string, clientEffect: "yes"|"no"|"unverified", userFacing: boolean, known: "no"|"ongoing"|"fixed"|"harmless", notes: string[] }`

Policy file shape (this exact content goes in `config/priority-policy.json` and `DEFAULT_POLICY`):

```json
{
  "version": 1,
  "minSample": 3,
  "majority": 0.5,
  "userFacing": { "default": true, "byService": { "embedding-server": false }, "byClass": {} },
  "rules": [
    { "id": "test-traffic", "when": { "clientEffect": ["yes"], "traffic": ["test"] }, "priority": "low", "note": "affected traffic is test/demo" },
    { "id": "live-broad", "when": { "clientEffect": ["yes"], "broad": true }, "priority": "high", "note": "users affected: several customers or most of the sample" },
    { "id": "live-narrow", "when": { "clientEffect": ["yes"] }, "priority": "medium", "note": "users affected: one customer or a minority of the sample" },
    { "id": "unverified-user-facing", "when": { "clientEffect": ["unverified"], "userFacing": true }, "priority": "medium", "note": "impact not verified; rated up" },
    { "id": "unverified-background", "when": { "clientEffect": ["unverified"], "userFacing": false }, "priority": "low", "note": "impact not verified; background path" },
    { "id": "known-discount", "when": { "clientEffect": ["no"], "known": ["fixed", "harmless"] }, "priority": "low", "note": "known; discounted" },
    { "id": "recurring-error", "when": { "clientEffect": ["no"], "alertSeverity": ["error"], "sustained": true }, "priority": "medium", "note": "no user impact found; recurring" },
    { "id": "no-impact", "when": { "clientEffect": ["no"] }, "priority": "low", "note": "no user impact found" }
  ],
  "raise": [
    { "id": "known-but-affected", "when": { "clientEffect": ["yes"], "known": ["fixed", "harmless"] }, "atLeast": "medium", "note": "marked known but users still affected" }
  ]
}
```

Semantics the tests below pin:
- Derived client effect: `reads.ok === 0` → `unverified`. Else `sampleAffected > 0` → `yes`. Else `clientEffectVerified && sampleChecked >= minSample && !reads.degraded` → `no`. Else `unverified`.
- `broad` is true when `scope === "multiple"` or `sampleAffected / sampleChecked >= majority`.
- `traffic: "unknown"` matches as `live` (it never matches `["test"]`).
- `userFacing`: `byService[service]` if present, else `byClass[alertClass]` if present, else `default`.
- A `when` key matches if absent; array keys match by membership; boolean keys by equality. Allowed `when` keys: `clientEffect`, `traffic`, `broad`, `userFacing`, `known`, `alertSeverity`, `sustained`. Any other key makes the policy invalid.
- Rules: first match wins. Then each `raise` entry that matches lifts the priority to `atLeast` if it is lower and appends its note.
- `known` other than `no` with `!validKnownRef(known, knownRef)` is treated as `no` and adds the note `known reference not accepted`.
- `validKnownRef`: `harmless` accepts only `pattern:<id>` matching `/^pattern:[a-z0-9-]{3,60}$/`. `ongoing` and `fixed` accept that, a ticket id `/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/`, or a Slack link `/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{10,20}(\?\S{0,200})?$/`.

- [ ] **Step 1: Write the failing tests** in `priority.test.mjs`

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/livex-slack-summary && node --test priority.test.mjs`
Expected: FAIL, `Cannot find module ... priority.mjs`

- [ ] **Step 3: Create `config/priority-policy.json`** with the JSON above, and **implement `priority.mjs`** with the four exports and the semantics listed. `loadPolicy` validates: `version === 1`, `minSample` integer 1 to 20, `majority` in (0, 1], `userFacing.default` boolean with object maps of booleans, every rule `{id, when, priority, note}` with allowed `when` keys and a priority in `high|medium|low`, at least one rule whose `when` has only `clientEffect` for each of `yes`, `no`, `unverified` (so every fact set matches something).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test priority.test.mjs`
Expected: all tests pass

- [ ] **Step 5: Update `package.json`** (`files`, `scripts.test`) and **commit**

```bash
git add livex-native/config/priority-policy.json livex-native/plugins/livex-slack-summary/priority.mjs livex-native/plugins/livex-slack-summary/priority.test.mjs livex-native/plugins/livex-slack-summary/package.json
git commit -m "feat(livex-slack-summary): priority policy and computePriority" #!axme pr=53 repo=livex-ai/livex-openclaw
```

---

### Task 2: Record what the logs tool returned

**Files:**
- Modify: `plugins/livex-slack-summary/core.mjs` (`afterToolCall` near line 742, `evidenceOptionsFor` near line 730)
- Test: `plugins/livex-slack-summary/attachments.test.mjs`

**Interfaces:**
- Consumes: the existing `afterToolCall(event, ctx)` record of evidence URLs per session (same TTL `EVIDENCE_TTL_MS`, same session bound `MAX_SESSIONS`).
- Produces: inside `createPlugin`, `readStatsFor(sessionKey: string): { ok: number, degraded: boolean }`. It returns `{ ok: 0, degraded: false }` for an unknown or expired session.

A `livex_gcp_logs_read` result counts as **ok** when the event has no `error` and its details parse. It marks the session **degraded** when the event has an `error`, or details show `truncated === true`, `complete === false`, or a non-empty `truncationReasons` array. Other tools are ignored.

- [ ] **Step 1: Write the failing test** (append to `attachments.test.mjs`; `load`, `SESSION` and the tool-result helper already exist in `test-helpers.mjs`; add an exported `readStats(loaded, sessionKey)` helper there that calls the plugin's `readStatsFor`, which `createPlugin` must also return)

```js
test("logs reads are counted per thread and a capped, incomplete or failed read marks it degraded", () => {
  const loaded = load();
  assert.deepEqual(readStats(loaded, SESSION), { ok: 0, degraded: false });
  loaded.afterToolCall({ toolName: "livex_gcp_logs_read", result: { details: { entries: [], truncated: false, truncationReasons: [] } } }, { sessionKey: SESSION });
  assert.deepEqual(readStats(loaded, SESSION), { ok: 1, degraded: false });
  loaded.afterToolCall({ toolName: "livex_repository_read", result: { details: { truncated: true } } }, { sessionKey: SESSION });
  assert.deepEqual(readStats(loaded, SESSION), { ok: 1, degraded: false });
  for (const details of [{ truncated: true }, { complete: false }, { truncationReasons: ["row-limit"] }]) {
    const fresh = load();
    fresh.afterToolCall({ toolName: "livex_gcp_logs_read", result: { details } }, { sessionKey: SESSION });
    assert.deepEqual(readStats(fresh, SESSION), { ok: 1, degraded: true });
  }
  const failed = load();
  failed.afterToolCall({ toolName: "livex_gcp_logs_read", error: "boom" }, { sessionKey: SESSION });
  assert.deepEqual(readStats(failed, SESSION), { ok: 0, degraded: true });
  assert.deepEqual(readStats(loaded, "agent:debugger:slack:channel:c0other:thread:1.2"), { ok: 0, degraded: false });
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test attachments.test.mjs` → FAIL (`readStatsFor is not a function`)
- [ ] **Step 3: Implement** the counters alongside the existing per-session evidence record and return `readStatsFor` from `createPlugin`.
- [ ] **Step 4: Run** `node --test index.test.mjs interactive.test.mjs amend.test.mjs attachments.test.mjs` → all pass
- [ ] **Step 5: Commit** — `feat(livex-slack-summary): track logs-read outcomes per thread`

---

### Task 3: V3 facts envelope, computed priority and the Why line

**Files:**
- Modify: `plugins/livex-slack-summary/core.mjs` (`SUMMARY_MARKER` line 9, `REQUIRED_KEYS`/`ALLOWED_KEYS` lines 54 to 64, `invalidCardField` 149, `parseSummary` 172, `classifyEnvelope` 245, `priorityText`/`priorityLine`/`sectionTexts` 279 to 315, `colorOf` 354, `renderPresentation` 413, `createPlugin` 717, `replyPayloadSending` 825, `beforeToolCall` 931)
- Modify: `plugins/livex-slack-summary/index.ts` (load the policy, pass it in)
- Modify: `plugins/livex-slack-summary/openclaw.plugin.json` (config key `priorityPolicyPath`, string)
- Modify: `plugins/livex-slack-summary/test-helpers.mjs` (`MARK`, `summary`, `envelope`)
- Test: `plugins/livex-slack-summary/index.test.mjs`, `amend.test.mjs`, `attachments.test.mjs`

**Interfaces:**
- Consumes: `computePriority`, `loadPolicy`, `DEFAULT_POLICY` (Task 1); `readStatsFor` (Task 2).
- Produces:
  - `SUMMARY_MARKER = "LIVEX_ALERT_SUMMARY_V3"`.
  - Envelope keys, required: `title`, `signature`, `alertClass`, `service`, `alertSeverity`, `sustained`, `known`, `sampleChecked`, `sampleAffected`, `scope`, `traffic`, `clientEffectVerified`, `summary`, `nextAction`, `owner`, `checkedWindow`. Optional: `knownRef`, `resolved`, `evidenceUrl`, `alternates`. `priority` and `provisional` are unknown keys now.
  - Field rules: `alertClass` and `service` match `/^[a-z][a-z0-9-]{1,59}$/`; `alertSeverity` in `error|warning|info`; `known` in `no|ongoing|fixed|harmless`; `scope` in `single|multiple|unknown`; `traffic` in `live|test|unknown`; `sustained` and `clientEffectVerified` boolean; `sampleChecked` integer 0 to 500; `sampleAffected` integer 0 to `sampleChecked`; `knownRef` a single line of 1 to 200 characters when present.
  - `alternates`: optional array of at most 4 objects, each with `title` plus the eleven fact keys and optional `knownRef`.
  - `classifyEnvelope(rawText, evidenceOptions, rating?: { policy, reads })` returns `{ marked, card }` where `card` gains `priority` (computed), `rating` (the `Rating`), `why` (string) and `also` (array of `{ title, priority }`). When `rating` is omitted it uses `DEFAULT_POLICY` and `{ ok: 0, degraded: false }`.
  - `createPlugin(rawConfig, { now, key, warn, policy })`.
  - `globalThis[Symbol.for("livex.priority-engine.v1")] = { results: Map<sessionKey, { runId, at, primary: { signature, priority, ruleId }, compute(facts) }> }`, written in `replyPayloadSending` for each rendered card; at most 500 sessions, entries older than 30 minutes pruned on write. `compute(facts)` returns a `Rating` using that session's policy and read stats.

Card text:
- Priority section: `*Priority:* 🔴 High` / `🟡 Medium` / `⚪ Low`; resolved cards keep `🟢 Resolved · was <Level>`.
- New section directly under Priority: `*Why:* <effect> · known: <known> · alert: <severity>[, recurring]`, where `<effect>` is `clients affected (<a> of <n> sampled)`, `no client effect found (<n> sampled)` or `client effect not verified (<a> of <n> sampled[, a read was capped or failed])`; `<known>` is `no`, or `<state> (<knownRef>)`. The whole line is passed through `neutralize` and cut to 300 characters.
- When `alternates` is present, each is rated; the highest becomes the card's priority, title and facts (ties keep the main one); the rest appear in one context line `Also: <title> — <Level>; …` (neutralized, at most 300 characters).
- Color: `high` red `#D92D20`, `medium` amber `#D99A00`, `low` gray `#9CA3AF`, resolved green.

- [ ] **Step 1: Update `test-helpers.mjs`** — `MARK = "LIVEX_ALERT_SUMMARY_V3"`; `summary` becomes

```js
export const summary = {
  title: "checkout-api upstream timeouts",
  signature: "checkout-api | create order | upstream timeout",
  alertClass: "gke-application-errors", service: "chat-engine", alertSeverity: "error", sustained: false,
  known: "no", sampleChecked: 5, sampleAffected: 1, scope: "single", traffic: "live", clientEffectVerified: true,
  summary: "An upstream timeout was recovered by the request retry.",
  nextAction: "Confirm whether later requests needed retries.",
  owner: "Unassigned",
  checkedWindow: "2026-01-21 12:20–12:25 UTC",
};
```

and add `recordRead(loaded, details = { entries: [], truncated: false, truncationReasons: [] }, sessionKey = SESSION)` which calls `afterToolCall` with a `livex_gcp_logs_read` result.

- [ ] **Step 2: Write the failing tests** (in `index.test.mjs`; `postCard` and `flat` exist)

```js
test("the card shows the computed priority and why", () => {
  const loaded = load();
  recordRead(loaded);
  const text = flat(postCard(loaded));
  assert.match(text, /\*Priority:\* 🟡 Medium/u);
  assert.match(text, /\*Why:\* clients affected \(1 of 5 sampled\) · known: no · alert: error/u);
  assert.equal(colorOf(cardOf(postCard(loaded))), "#D99A00");
});

test("with no recorded read the effect is not verified and a user-facing alert is rated up", () => {
  const text = flat(postCard(load()));
  assert.match(text, /\*Priority:\* 🟡 Medium/u);
  assert.match(text, /client effect not verified \(1 of 5 sampled\)/u);
});

test("a capped read turns 'no effect' into not verified", () => {
  const loaded = load();
  recordRead(loaded, { truncated: true });
  const text = flat(postCard(loaded, { fields: { ...summary, sampleAffected: 0 } }));
  assert.match(text, /client effect not verified \(0 of 5 sampled, a read was capped or failed\)/u);
});

test("impossible sample counts replace the card with the notice and log the reason", () => {
  for (const bad of [{ sampleAffected: 6 }, { sampleAffected: -1 }, { sampleChecked: 2.5 }, { sampleChecked: 501 }]) {
    const loaded = load();
    const out = postCard(loaded, { fields: { ...summary, ...bad } });
    assert.equal(out.payload.text, INVALID_SUMMARY);
    assert.match(loaded.warnings.at(-1), /summary card replaced by notice: invalid field sample(Affected|Checked)$/u);
  }
});

test("V2 envelopes and model-written priority are rejected", () => {
  const loaded = load();
  assert.equal(postCard(loaded, { marker: "LIVEX_ALERT_SUMMARY_V2" }).payload.text, INVALID_SUMMARY);
  assert.equal(postCard(loaded, { fields: { ...summary, priority: "high" } }).payload.text, INVALID_SUMMARY);
});

test("a known reference is shown as inert text and an unaccepted one counts as no", () => {
  const loaded = load();
  recordRead(loaded);
  const shown = flat(postCard(loaded, { fields: { ...summary, known: "ongoing", knownRef: "LX-12525" } }));
  assert.match(shown, /known: ongoing \(LX-12525\)/u);
  const hostile = flat(postCard(loaded, { fields: { ...summary, known: "fixed", knownRef: "<!channel> <https://evil.example|LX-1>" } }));
  assert.match(hostile, /known: no/u);
  assert.doesNotMatch(hostile, /<!channel>|<https:\/\/evil/u);
});

test("alternates: the highest-rated fact set becomes the card and the rest are listed", () => {
  const loaded = load();
  recordRead(loaded);
  const alt = { ...factsOf(summary), title: "avatar sessions silent", sampleAffected: 4 };
  const text = flat(postCard(loaded, { fields: { ...summary, alternates: [alt] } }));
  assert.match(text, /\*Title:\* avatar sessions silent/u);
  assert.match(text, /\*Priority:\* 🔴 High/u);
  assert.match(text, /Also: checkout-api upstream timeouts — Medium/u);
});

test("the priority engine registry carries the result for the memory plugin", () => {
  const loaded = load();
  recordRead(loaded);
  postCard(loaded, { runId: "run-1" });
  const entry = globalThis[Symbol.for("livex.priority-engine.v1")].results.get(SESSION);
  assert.equal(entry.runId, "run-1");
  assert.deepEqual(entry.primary, { signature: summary.signature, priority: "medium", ruleId: "live-narrow" });
  assert.equal(entry.compute({ ...factsOf(summary), sampleAffected: 4 }).priority, "high");
});
```

(`factsOf(fields)` is a test helper returning the eleven fact keys plus `knownRef`; `cardOf` returns the card the plugin rendered; `loaded.warnings` collects `warn` calls; `postCard` gains `marker` and `runId` options. Add them to `test-helpers.mjs`.)

- [ ] **Step 3: Run to verify they fail** — `node --test index.test.mjs` → FAIL
- [ ] **Step 4: Implement** the envelope change, the rating call in `parseSummary` (invalid-field reasons use the field name), the Why and Also lines in `sectionTexts`/`renderBlocks`/`renderPresentation`, the color mapping, the registry write, and policy loading in `index.ts` via `loadPolicy(api.pluginConfig?.priorityPolicyPath, warn)`. Remove `provisional`, `unknown` and `critical` from the labels and from `applyChoice`/`availableChoices`; the button token (`encodeState`/`decodeState`) carries `priority`, `why` and `also` in place of `provisional`. `beforeToolCall` passes the same `{ policy, reads }` so amendments are recomputed.
- [ ] **Step 5: Update the existing tests** in `index.test.mjs`, `interactive.test.mjs`, `amend.test.mjs`, `attachments.test.mjs` that assert V2 fields, "(provisional)" or the old priority values, so they assert the V3 behaviour above. Do not delete a test whose behaviour still exists.
- [ ] **Step 6: Run** `node --test priority.test.mjs index.test.mjs interactive.test.mjs amend.test.mjs attachments.test.mjs` → all pass
- [ ] **Step 7: Commit** — `feat(livex-slack-summary): V3 facts envelope with computed priority`

---

### Task 4: Memory plugin stores facts and the computed priority

**Files:**
- Modify: `plugins/livex-investigations-lite/core.mjs` (`PRIORITIES` line 3, `buildStagedRecord` 214, `mergeCase` 241, `SUMMARY_MARKER_V2` 295, `readSummaryEnvelope` 343, `renderSeenBefore` 564, `toLookupDetails` 582, `createMemory.delivered` ~line 770, `createRecordTool` 827)
- Test: `plugins/livex-investigations-lite/core.test.mjs`, `index.test.mjs`, `test-helpers.mjs`

**Interfaces:**
- Consumes: `globalThis[Symbol.for("livex.priority-engine.v1")].results.get(sessionKey)` → `{ runId, at, primary: { signature, priority, ruleId }, compute(facts) }` (Task 3). The plugin must work when it is absent.
- Produces:
  - `SUMMARY_MARKER_V3 = "LIVEX_ALERT_SUMMARY_V3"`; `readSummaryEnvelope` accepts exactly the key set and field rules of Task 3 (same accept/reject results as the card plugin) and returns `{ record }` with `record.facts` (the eleven fact keys plus `knownRef`) and no `priority`.
  - `PRIORITIES = ["high", "medium", "low", "unrated"]`.
  - `investigation_record` parameters: `signature`, `title`, `finding`, `resolved`, `trend` as today, plus the eleven fact keys (required) and `knownRef` (optional). `priority` is removed.
  - At commit, each staged record gets `priority` from the registry: the envelope record whose signature equals `primary.signature` takes `primary.priority`; any other record takes `compute(record.facts).priority`; with no registry entry the stored priority is `"unrated"` and one line `[livex-investigations-lite] priority engine unavailable; case stored unrated` is logged.
  - Stored occurrences keep `facts` and `ruleId`. The "seen before" block and lookup show `priority` and, when present, `known`.

- [ ] **Step 1: Write the failing tests** (in `core.test.mjs`; helpers `memoryStore`, `SESSION`, `SENDER`, `hooksFor` exist; add `v3Envelope(fields)` to `test-helpers.mjs` using the same `summary` fields as Task 3)

```js
test("V3 envelope: facts are staged and the committed case takes the engine's priority", async () => {
  const engine = Symbol.for("livex.priority-engine.v1");
  globalThis[engine] = { results: new Map([[SESSION, { runId: "r1", at: Date.now(), primary: { signature: "checkout-api | create order | upstream timeout", priority: "medium", ruleId: "live-narrow" }, compute: () => ({ priority: "high", ruleId: "live-broad" }) }]]) };
  const { hooks, store, memory } = hooksFor();
  hooks.replyPayloadSending({ kind: "final", channel: "slack", sessionKey: SESSION, runId: "r1", payload: { text: v3Envelope() } }, { sessionKey: SESSION, senderId: SENDER, runId: "r1" });
  await hooks.messageSent({ sessionKey: SESSION, success: true, messageId: "1768996900.000100" }, { sessionKey: SESSION });
  await memory.settled();
  const [row] = await store.entries();
  const last = row.value.occurrences.at(-1);
  assert.equal(last.priority, "medium");
  assert.equal(last.ruleId, "live-narrow");
  assert.equal(last.facts.sampleAffected, 1);
  delete globalThis[engine];
});

test("without the engine the case is stored unrated and says so once", async () => {
  delete globalThis[Symbol.for("livex.priority-engine.v1")];
  const { hooks, store, memory, lines } = hooksFor();
  hooks.replyPayloadSending({ kind: "final", channel: "slack", sessionKey: SESSION, runId: "r1", payload: { text: v3Envelope() } }, { sessionKey: SESSION, senderId: SENDER, runId: "r1" });
  await hooks.messageSent({ sessionKey: SESSION, success: true, messageId: "1768996900.000100" }, { sessionKey: SESSION });
  await memory.settled();
  assert.equal((await store.entries())[0].value.occurrences.at(-1).priority, "unrated");
  assert.equal(lines.filter((l) => l.includes("priority engine unavailable")).length, 1);
});

test("V2 envelopes, model-written priority and impossible samples record nothing", () => {
  for (const text of [v3Envelope().replace("_V3", "_V2"), v3Envelope({ priority: "high" }), v3Envelope({ sampleAffected: 9 })]) {
    assert.equal(readSummaryEnvelope(text).record, undefined);
  }
});
```

- [ ] **Step 2: Run to verify they fail** — `cd plugins/livex-investigations-lite && node --test core.test.mjs` → FAIL
- [ ] **Step 3: Implement** the envelope, record tool, commit and rendering changes. Existing stored cases (V2 occurrences with `priority` and no `facts`) stay readable: render their priority as stored.
- [ ] **Step 4: Update existing tests** that build V2 envelopes or pass `priority` to the record tool.
- [ ] **Step 5: Run** `node --test core.test.mjs index.test.mjs` → all pass
- [ ] **Step 6: Parity check** — add to `plugins/livex-slack-summary/attachments.test.mjs`:

```js
test("card plugin and memory plugin accept and reject the same V3 envelopes", async () => {
  const lite = await import("../livex-investigations-lite/core.mjs");
  const variants = [{}, { priority: "high" }, { sampleAffected: 9 }, { known: "maybe" }, { alertClass: "Bad Class" }, { knownRef: "x".repeat(201) }, { scope: "many" }, { extra: 1 }];
  for (const v of variants) {
    const text = envelope({ ...summary, ...v });
    assert.equal(Boolean(classifyEnvelope(text).card), Boolean(lite.readSummaryEnvelope(text).record), JSON.stringify(v));
  }
});
```

Run both plugins' suites → all pass. (This test imports across plugin directories; test files are not shipped, so the "no cross-plugin import" rule is not broken.)
- [ ] **Step 7: Commit** — `feat(livex-investigations-lite): store facts and the computed priority`

---

### Task 5: Ship the policy path in the deployed config

**Files:**
- Modify: `deploy/apply.mjs` (where `managedPluginIds` load paths are set, ~line 346)
- Modify: `deploy/test_apply.mjs` (fresh-install test, ~line 199)

**Interfaces:**
- Produces: after apply, `plugins.entries["livex-slack-summary"].config.priorityPolicyPath === "<native dir>/config/priority-policy.json"`, where the native dir is the same root apply already uses for plugin load paths (`LIVEX_PLUGIN_ROOT` when set, else `LIVEX_NATIVE_DIR`'s deployed location). Other keys of that config object are left as merged.

- [ ] **Step 1: Write the failing assertion** in the fresh-install test:

```js
assert.match(config.plugins.entries["livex-slack-summary"].config.priorityPolicyPath, /\/config\/priority-policy\.json$/);
assert.equal(config.plugins.entries["livex-slack-summary"].config.buttons, false);
```

and change the existing `deepEqual` on that config object to compare the other keys only.
- [ ] **Step 2: Run** `LIVEX_JSON5_FROM="/Volumes/SSK SSD/chat-frontend-audio-regression/package.json" node deploy/test_apply.mjs` → FAIL
- [ ] **Step 3: Implement** the assignment in `buildNextConfig`.
- [ ] **Step 4: Run** the same command and `python3 -B deploy/test_deploy.py` → pass
- [ ] **Step 5: Commit** — `feat(livex-native/deploy): point the card plugin at the priority policy`

---

### Task 6: Skill, agent instructions and playbooks report facts

**Files:**
- Modify: `agents/debugger/AGENTS.md`
- Modify: `agents/debugger/skills/investigate-alerts/SKILL.md`
- Modify: `agents/debugger/skills/investigate-alerts/severity-policy.md`
- Modify: `agents/debugger/skills/investigate-alerts/references/{gke-application-errors,phone-call-notes,error-digest-categories,low-conversation-volume,log-match-alerts}.md`
- Create: `plugins/livex-slack-summary/docs.test.mjs` (add to `scripts.test`)

**Interfaces:**
- Consumes: the V3 envelope keys and field rules (Task 3); `investigation_record` parameters (Task 4); accepted `knownRef` kinds (Task 1).

Content rules:
- The workflow's last steps become: run the playbook's **Client effect check**, **Sustained check** and **Known patterns**; then write the V3 envelope with the facts. The text "assign severity/priority", every "provisional" rule, "Priority unknown" and "Unknown priority is not low priority" are removed. State once: "You do not choose the priority. The Gateway computes it from these facts."
- Field guidance, one line each, including: `sampleChecked`/`sampleAffected` are counts of conversations, calls or requests you actually inspected; set `clientEffectVerified` false when you could not inspect any; `traffic` is `test` only when the affected agents are demo or test agents; `known` is `no` unless a person said so in a thread (give the Slack thread link), a ticket exists (give the id), or the playbook lists the pattern (give `pattern:<id>`); a case-memory hit alone is "seen before", mentioned in `summary`, with `known: "no"`.
- When `known` is `ongoing`: still run the client effect check; do not re-derive the cause.
- Digest threads: put the category you judge most serious in the main fields and up to four others in `alternates`.
- One complete V3 example line in SKILL.md (valid JSON on one line).
- Each playbook: remove its `## Severity` section; add `## Client effect check` (what to sample, N of 5 by default, what "affected" means for this alert), `## Sustained check` (the rule that sets `sustained`), `## Known patterns` (a table `id | pattern | state (fixed or harmless) | since | source`, ids matching `[a-z0-9-]{3,60}`; start with only patterns a human conclusion supports, otherwise an empty table), and `## Alert severity` (the fixed `alertSeverity` when the alert text has none; `alertClass` and the `service` values to use).
- `severity-policy.md` becomes a short pointer to `config/priority-policy.json` and explains the three facts; the DRAFT banner stays until the owner confirms the table.
- Playbook edits by people only: the debugger may suggest a change in the thread.

- [ ] **Step 1: Write the failing test** `docs.test.mjs`

```js
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
```

- [ ] **Step 2: Run** `node --test docs.test.mjs` → FAIL
- [ ] **Step 3: Edit the eight files** to the content rules.
- [ ] **Step 4: Run** `node --test docs.test.mjs` → pass
- [ ] **Step 5: Commit** — `docs(debugger): report facts; the Gateway computes priority`

---

### Task 7: Replay set, full verification and DEV deploy

**Files:**
- Create: `plugins/livex-slack-summary/replay/alerts.json`
- Create: `plugins/livex-slack-summary/replay.test.mjs` (add to `scripts.test`)

**Interfaces:**
- Consumes: `computePriority`, `DEFAULT_POLICY` (Task 1).

`alerts.json` is an array of `{ name, thread, facts, reads, expected, ownerConfirmed }`. Seed it with the five live alerts from 2026-11-14, with the facts a careful reader would report from the bot's own findings, and `expected` set to what the starting table gives. `ownerConfirmed` is `false` until the owner checks each one.

| name | key facts | reads | expected |
|---|---|---|---|
| api-gateway errors, 15 in 10 min | chat path, checked 5, affected 0, verified, not sustained, known no | ok 3, not degraded | low |
| language-detection timeouts (109 in digest) | chat-engine, checked 1, affected 0, verified | ok 4, degraded | medium |
| phone call notes missing | class phone-call-notes, service conversation-telephony, checked 0, not verified | ok 0 | medium |
| conversation-avatar ElevenLabs errors | conversation-avatar, checked 6, affected 3, scope single, live | ok 3, degraded | high (3 of 6 is at least half) |
| conversation-avatar silent session | conversation-avatar, checked 2, affected 1, scope single, live, sustained | ok 3, not degraded | high (1 of 2 is at least half) |

- [ ] **Step 1: Write `replay.test.mjs`**: for each entry, `computePriority(facts, DEFAULT_POLICY, reads).priority === expected`; and a second test that fails with the list of names when any entry has `ownerConfirmed !== true` **only if** the environment variable `LIVEX_REPLAY_REQUIRE_CONFIRMED=1` is set (so the suite passes before the owner's review and can be made strict afterwards).
- [ ] **Step 2: Run** `node --test replay.test.mjs` → pass
- [ ] **Step 3: Run every suite**

```bash
cd livex-native
(cd plugins/livex-slack-summary && node --test priority.test.mjs index.test.mjs interactive.test.mjs amend.test.mjs attachments.test.mjs docs.test.mjs replay.test.mjs)
(cd plugins/livex-investigations-lite && node --test core.test.mjs index.test.mjs)
(cd plugins/livex-gcp-readonly && node --test *.test.mjs)
LIVEX_SLACK_PACKAGE_DIR=<extracted @openclaw/slack 2026.10.5> node --test deploy/test_patch_slack_attachments.mjs deploy/test_patch_identifiers.mjs
LIVEX_JSON5_FROM="/Volumes/SSK SSD/chat-frontend-audio-regression/package.json" node deploy/test_apply.mjs
python3 -B deploy/test_deploy.py
```

Expected: 0 failures in each.
- [ ] **Step 4: Commit and push** — `test(livex-slack-summary): replay live alerts through the priority table`
- [ ] **Step 5 (needs the owner's go-ahead): deploy to DEV** with `LIVEX_TEST_IAP=0 make deploy_dev CONFIRM=livex-openclaw-dev` from the worktree root with `/Users/tanmesh/google-cloud-sdk/bin` on `PATH`; confirm in `docker logs` that the Gateway is ready, memory registered, and there is no `priority policy` warning.
- [ ] **Step 6: Live check in Slack (owner):** mention the bot on a fresh alert; the card shows High, Medium or Low with a Why line; `docker logs` shows `case committed`; the stored case has a priority that is not `unrated`.
