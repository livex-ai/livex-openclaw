import fs from "node:fs";

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

// Keep identical in value to config/priority-policy.json (a test pins this).
export const DEFAULT_POLICY = deepFreeze({
  version: 1,
  minSample: 3,
  majority: 0.5,
  userFacing: { default: true, byService: { "embedding-server": false }, byClass: {} },
  rules: [
    { id: "test-traffic", when: { clientEffect: ["yes"], traffic: ["test"] }, priority: "low", note: "affected traffic is test/demo" },
    { id: "live-broad", when: { clientEffect: ["yes"], broad: true }, priority: "high", note: "users affected: several customers or most of the sample" },
    { id: "live-narrow", when: { clientEffect: ["yes"] }, priority: "medium", note: "users affected: one customer or a minority of the sample" },
    { id: "unverified-user-facing", when: { clientEffect: ["unverified"], userFacing: true }, priority: "medium", note: "impact not verified; rated up" },
    { id: "unverified-background", when: { clientEffect: ["unverified"], userFacing: false }, priority: "low", note: "impact not verified; background path" },
    { id: "known-discount", when: { clientEffect: ["no"], known: ["fixed", "harmless"] }, priority: "low", note: "known; discounted" },
    { id: "recurring-error", when: { clientEffect: ["no"], alertSeverity: ["error"], sustained: true }, priority: "medium", note: "no user impact found; recurring" },
    { id: "no-impact", when: { clientEffect: ["no"] }, priority: "low", note: "no user impact found" },
  ],
  raise: [
    { id: "known-but-affected", when: { clientEffect: ["yes"], known: ["fixed", "harmless"] }, atLeast: "medium", note: "marked known but users still affected" },
  ],
  // `pattern:<id>` references accepted as known (the playbooks' Known patterns tables).
  knownPatterns: ["wyze-zendesk-suspended-requester", "wyze-malformed-agent-id", "avatar-tts-flash-v3-model"],
  // Slack workspaces whose thread links are accepted; empty or missing accepts any.
  slackWorkspaces: ["livexai"],
});

const WHEN_KEYS = new Set(["clientEffect", "traffic", "broad", "userFacing", "known", "alertSeverity", "sustained"]);
const PRIORITIES = ["low", "medium", "high"];
const PATTERN_ID = /^[a-z0-9-]{3,60}$/;
const WORKSPACE_ID = /^[a-z0-9-]{1,40}$/;
const PATTERN_REF = /^pattern:([a-z0-9-]{3,60})$/;
const TICKET_REF = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const SLACK_REF = /^https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{10,20}(\?\S{0,200})?$/;

/** A `pattern:<id>` listed in policy.knownPatterns (a missing list accepts none). */
function listedPattern(ref, policy) {
  const id = PATTERN_REF.exec(ref)?.[1];
  return id !== undefined && Array.isArray(policy?.knownPatterns) && policy.knownPatterns.includes(id);
}

/** A Slack thread link on a workspace in policy.slackWorkspaces (an empty or missing list accepts any). */
function listedSlackLink(ref, policy) {
  const workspace = SLACK_REF.exec(ref)?.[1];
  if (workspace === undefined) return false;
  const list = policy?.slackWorkspaces;
  return !Array.isArray(list) || list.length === 0 || list.includes(workspace);
}

export function validKnownRef(known, ref, policy) {
  if (typeof ref !== "string") return false;
  if (known === "harmless") return listedPattern(ref, policy);
  if (known === "ongoing" || known === "fixed") return listedPattern(ref, policy) || TICKET_REF.test(ref) || listedSlackLink(ref, policy);
  return false;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmptyStr = (v) => typeof v === "string" && v.length > 0;

const BOOL_KEYS = new Set(["broad", "userFacing", "sustained"]);

/** Every key is a known fact; booleans for broad/userFacing/sustained, else a non-empty list of in-domain values. */
function validWhen(when) {
  if (!isObj(when)) return false;
  return Object.entries(when).every(([k, v]) =>
    WHEN_KEYS.has(k) &&
    (BOOL_KEYS.has(k)
      ? typeof v === "boolean"
      : Array.isArray(v) && v.length > 0 && v.every((item) => STATE_VALUES[k].includes(item))));
}

const validIdList = (list, pattern) => Array.isArray(list) && list.every((id) => typeof id === "string" && pattern.test(id));

function validBoolMap(m) {
  return isObj(m) && Object.values(m).every((v) => typeof v === "boolean");
}

const STATE_VALUES = {
  clientEffect: ["yes", "no", "unverified"],
  traffic: ["live", "test"],
  broad: [true, false],
  userFacing: [true, false],
  known: ["no", "ongoing", "fixed", "harmless"],
  alertSeverity: ["error", "warning", "info"],
  sustained: [true, false],
};

// Every combination of derived state must match at least one rule.
function coversEveryState(rules) {
  const keys = Object.keys(STATE_VALUES);
  const walk = (i, state) =>
    i === keys.length
      ? rules.some((r) => matches(r.when, state))
      : STATE_VALUES[keys[i]].every((v) => walk(i + 1, { ...state, [keys[i]]: v }));
  return walk(0, {});
}

function policyProblem(p) {
  if (!isObj(p)) return "is not an object";
  if (p.version !== 1) return "has an unsupported version";
  if (!Number.isInteger(p.minSample) || p.minSample < 1 || p.minSample > 20) return "has an invalid minSample";
  if (typeof p.majority !== "number" || !(p.majority > 0 && p.majority <= 1)) return "has an invalid majority";
  const uf = p.userFacing;
  if (!isObj(uf) || typeof uf.default !== "boolean" || !validBoolMap(uf.byService) || !validBoolMap(uf.byClass)) return "has an invalid userFacing";
  if (!Array.isArray(p.rules) || p.rules.length === 0) return "has no rules";
  for (const r of p.rules) {
    if (!isObj(r) || !nonEmptyStr(r.id) || !nonEmptyStr(r.note) || !PRIORITIES.includes(r.priority) || !validWhen(r.when)) return "has an invalid rule";
  }
  if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length) return "has duplicate rule ids";
  if (!coversEveryState(p.rules)) return "has rules that leave some fact sets unmatched";
  if (p.raise !== undefined) {
    if (!Array.isArray(p.raise)) return "has an invalid raise list";
    for (const r of p.raise) {
      if (!isObj(r) || !nonEmptyStr(r.id) || !nonEmptyStr(r.note) || !PRIORITIES.includes(r.atLeast) || !validWhen(r.when)) return "has an invalid raise entry";
    }
    if (new Set(p.raise.map((r) => r.id)).size !== p.raise.length) return "has duplicate raise ids";
  }
  if (p.knownPatterns !== undefined && !validIdList(p.knownPatterns, PATTERN_ID)) return "has an invalid knownPatterns list";
  if (p.slackWorkspaces !== undefined && !validIdList(p.slackWorkspaces, WORKSPACE_ID)) return "has an invalid slackWorkspaces list";
  return null;
}

export function loadPolicy(path, warn) {
  if (path === undefined) return DEFAULT_POLICY;
  let reason;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    reason = policyProblem(parsed);
    if (!reason) return { ...parsed, raise: parsed.raise ?? [], knownPatterns: parsed.knownPatterns ?? [], slackWorkspaces: parsed.slackWorkspaces ?? [] };
  } catch {
    reason = "could not be read or parsed";
  }
  try {
    warn(`livex-slack-summary: priority policy ${reason}; using the built-in default`);
  } catch {
    // warn must never break loading
  }
  return DEFAULT_POLICY;
}

/**
 * `{ effect, fewOutcomes }`. "no" needs a clean, verified sample of at least minSample items and
 * at least minSample outcome reads (id-scoped or complete-count reads; a missing count is 0).
 * fewOutcomes marks the case where the outcome reads alone kept it from "no".
 */
function deriveClientEffect(facts, policy, reads) {
  if (!reads || !(reads.ok > 0)) return { effect: "unverified", fewOutcomes: false };
  if (facts.sampleAffected > 0) return { effect: "yes", fewOutcomes: false };
  if (facts.clientEffectVerified && facts.sampleChecked >= policy.minSample && !reads.degraded) {
    return (reads.outcomes ?? 0) >= policy.minSample
      ? { effect: "no", fewOutcomes: false }
      : { effect: "unverified", fewOutcomes: true };
  }
  return { effect: "unverified", fewOutcomes: false };
}

function matches(when, state) {
  return Object.entries(when).every(([k, v]) => (Array.isArray(v) ? v.includes(state[k]) : state[k] === v));
}

export function computePriority(facts, policy, reads) {
  const notes = [];
  let known = facts.known;
  if (known !== "no" && !validKnownRef(known, facts.knownRef, policy)) {
    known = "no";
    notes.push("known reference not accepted");
  }
  const { effect: clientEffect, fewOutcomes } = deriveClientEffect(facts, policy, reads);
  const uf = policy.userFacing;
  const userFacing = Object.hasOwn(uf.byService, facts.service)
    ? uf.byService[facts.service]
    : Object.hasOwn(uf.byClass, facts.alertClass)
      ? uf.byClass[facts.alertClass]
      : uf.default;
  const broad = facts.scope === "multiple" || (facts.sampleChecked > 0 && facts.sampleAffected / facts.sampleChecked >= policy.majority);
  const state = {
    clientEffect,
    traffic: facts.traffic === "test" ? "test" : "live",
    broad,
    userFacing,
    known,
    alertSeverity: facts.alertSeverity,
    sustained: facts.sustained,
  };
  const rule = policy.rules.find((r) => matches(r.when, state));
  let priority = rule.priority;
  notes.push(rule.note);
  for (const r of policy.raise ?? []) {
    if (matches(r.when, state)) {
      if (PRIORITIES.indexOf(priority) < PRIORITIES.indexOf(r.atLeast)) priority = r.atLeast;
      notes.push(r.note);
    }
  }
  return { priority, ruleId: rule.id, clientEffect, fewOutcomes, userFacing, known, notes };
}
