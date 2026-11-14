import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "./core.mjs";
import { createMetricsTool, parseAlertPolicyRef } from "./metrics.mjs";

const TOKEN = "ya29.FAKE_TOKEN_for_tests_0123456789abcdef";
const config = {
  gcloudPath: "/sdk/bin/gcloud",
  cloudSdkConfig: "/private/cloud",
  gcloudAccount: "reader@example.test",
  project: "example-prd",
  allowedSenderId: "U123",
  allowedChannelId: "C123",
};
const context = {
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent() {},
};
const NOW = Date.parse("2026-11-13T12:00:00Z");
const POLICY = "projects/example-prd/alertPolicies/123";

function harness({ routes = {}, token = TOKEN, gcloudFails = false } = {}) {
  const calls = [];
  const commands = [];
  const runCommand = async (argv, opts) => {
    commands.push({ argv, opts });
    if (gcloudFails) throw new Error(`boom ${token}`);
    return { code: 0, stdout: token + "\n", stderr: "" };
  };
  const http = async (url, { token: used }) => {
    calls.push({ url, used });
    const path = decodeURIComponent(new URL(url).pathname.replace("/v3/", ""));
    const route = routes[path] ?? routes["*"];
    if (!route) return { status: 404, text: "{}" };
    const r = typeof route === "function" ? route(new URL(url)) : route;
    return { status: r.status ?? 200, text: JSON.stringify(r.body ?? r) };
  };
  const tool = createMetricsTool(config, context, runCommand, { http, now: () => NOW });
  return { tool, calls, commands };
}

const policy = {
  name: POLICY,
  displayName: "High 5xx",
  documentation: { content: "x".repeat(3000) },
  notificationChannels: ["projects/example-prd/notificationChannels/SECRET"],
  conditions: [
    {
      displayName: "ratio",
      conditionThreshold: {
        filter: 'metric.type="run.googleapis.com/request_count"',
        comparison: "COMPARISON_GT",
        thresholdValue: 5,
        duration: "300s",
        evaluationMissingData: "EVALUATION_MISSING_DATA_INACTIVE",
        aggregations: [
          { alignmentPeriod: "120s", perSeriesAligner: "ALIGN_RATE", crossSeriesReducer: "REDUCE_SUM", groupByFields: ["resource.label.service_name"] },
        ],
      },
    },
    { displayName: "mql", conditionMonitoringQueryLanguage: { query: "fetch x | rate", duration: "60s" } },
    { displayName: "prom", conditionPrometheusQueryLanguage: { query: "up == 0", duration: "60s" } },
    { displayName: "absent", conditionAbsent: { filter: 'metric.type="a"', duration: "600s" } },
  ],
};
const window = { start: "2026-11-13T10:00:00Z", end: "2026-11-13T11:00:00Z" };

test("caller gate matches the logs tool", () => {
  const make = (patch) => createMetricsTool(config, { ...context, ...patch }, async () => ({}));
  assert.ok(make({}));
  assert.equal(make({ messageChannel: "discord" }), null);
  assert.equal(make({ nativeChannelId: "C999" }), null);
  assert.equal(make({ nativeChannelId: "D123" }), null);
  assert.equal(make({ requesterSenderId: "U999" }), null);
  assert.equal(make({ assertInvocationCurrent: undefined }), null);
  assert.equal(createMetricsTool(config, context, async () => ({})).name, "livex_gcp_metrics_read");
});

test("parameter validation rejects before any gcloud or network call", async () => {
  const { tool, calls, commands } = harness();
  const bad = {
    "unknown mode": { mode: "x" },
    "no mode": {},
    "window over 24h": { mode: "series", filter: "metric.type=\"a\"", start: "2026-11-12T10:00:00Z", end: "2026-11-13T10:00:01Z" },
    "future end": { mode: "series", filter: 'metric.type="a"', start: "2026-11-13T11:00:00Z", end: "2026-11-13T12:06:00Z" },
    "bad filter": { mode: "series", filter: 'project="x"', ...window },
    "end before start": { mode: "series", filter: 'metric.type="a"', start: window.end, end: window.start },
    "non-UTC": { mode: "series", filter: 'metric.type="a"', start: "2026-11-13T10:00:00+01:00", end: window.end },
    "period low": { mode: "series", filter: 'metric.type="a"', ...window, alignmentPeriod: 30 },
    "period high": { mode: "series", filter: 'metric.type="a"', ...window, alignmentPeriod: 7200 },
    "both sources": { mode: "series", filter: 'metric.type="a"', alertPolicy: POLICY, conditionIndex: 0, ...window },
    "condition without policy": { mode: "series", conditionIndex: 0, ...window },
    "policy without target": { mode: "policy" },
    "other project": { mode: "policy", alertPolicy: "projects/other/alertPolicies/1" },
    "extra param": { mode: "policy", alertPolicy: POLICY, project: "other" },
  };
  for (const [label, params] of Object.entries(bad))
    await assert.rejects(tool.execute("id", params), Error, label);
  assert.equal(calls.length, 0);
  assert.equal(commands.length, 0);
  // Boundary values are accepted.
  const ok = harness({ routes: { "*": { timeSeries: [] } } });
  await ok.tool.execute("id", { mode: "series", filter: 'resource.type="cloud_run_revision"', start: "2026-11-12T12:05:00Z", end: "2026-11-13T12:05:00Z", alignmentPeriod: 3600 });
});

test("alertPolicy parsing: resource names, alert URLs, policy URLs", () => {
  const p = "example-prd";
  assert.deepEqual(parseAlertPolicyRef(POLICY, p), { kind: "policy", name: POLICY, id: "123" });
  assert.deepEqual(
    parseAlertPolicyRef("https://console.cloud.google.com/monitoring/alerting/alerts/0.oezy72wrx7nw?channelType=slack&project=example-prd", p),
    { kind: "alert", name: "projects/example-prd/alerts/0.oezy72wrx7nw" },
  );
  assert.equal(
    parseAlertPolicyRef("https://console.cloud.google.com/monitoring/alerting/incidents/0.abc?project=example-prd", p).name,
    "projects/example-prd/alerts/0.abc",
  );
  assert.equal(
    parseAlertPolicyRef("https://console.cloud.google.com/monitoring/alerting/policies/777?project=example-prd", p).name,
    "projects/example-prd/alertPolicies/777",
  );
  for (const v of [
    "https://console.cloud.google.com/monitoring/alerting/alerts/0.abc?project=other",
    "https://evil.example/monitoring/alerting/alerts/0.abc",
    "http://console.cloud.google.com/monitoring/alerting/alerts/0.abc",
    "https://console.cloud.google.com/monitoring/dashboards/1",
    "projects/example-prd/alerts/1",
    "",
  ])
    assert.throws(() => parseAlertPolicyRef(v, p), v);
});

test("policy mode resolves an incident URL through alerts.get and trims output", async () => {
  const { tool, calls } = harness({
    routes: {
      "projects/example-prd/alerts/0.oezy72wrx7nw": { policy: { name: POLICY } },
      [POLICY]: policy,
    },
  });
  const r = await tool.execute("id", {
    mode: "policy",
    alertPolicy: "https://console.cloud.google.com/monitoring/alerting/alerts/0.oezy72wrx7nw?project=example-prd",
  });
  assert.deepEqual(Object.keys(r.details), ["policy", "conditionsOmitted", "untrusted"]);
  assert.deepEqual(Object.keys(r.details.untrusted), ["displayName", "documentation", "conditions"]);
  assert.equal(r.details.policy, POLICY);
  const u = r.details.untrusted;
  assert.ok(u.documentation.length <= 2001);
  assert.equal(u.conditions.length, 4);
  assert.equal(u.conditions[0].thresholdValue, 5);
  assert.equal(u.conditions[0].aggregations[0].perSeriesAligner, "ALIGN_RATE");
  assert.ok(!JSON.stringify(r.details).includes("notificationChannels"));
  assert.ok(calls.every((c) => new URL(c.url).hostname === "monitoring.googleapis.com"));
  assert.equal(calls.length, 2);
});

test("policyName resolves by exact displayName via list", async () => {
  const { tool } = harness({
    routes: {
      "projects/example-prd/alertPolicies": { alertPolicies: [{ name: "projects/example-prd/alertPolicies/9", displayName: "High 5xx extra" }, { name: POLICY, displayName: "High 5xx" }] },
      [POLICY]: policy,
    },
  });
  const r = await tool.execute("id", { mode: "policy", policyName: "High 5xx" });
  assert.equal(r.details.policy, POLICY);
  assert.equal(r.details.untrusted.displayName, "High 5xx");
  const none = harness({ routes: { "projects/example-prd/alertPolicies": { alertPolicies: [] } } });
  assert.equal((await none.tool.execute("id", { mode: "policy", policyName: "nope" })).details.error, "not-found");
});

test("series mode uses the condition's filter and aggregation and applies caps", async () => {
  const points = (n) =>
    Array.from({ length: n }, (_, i) => ({
      interval: { endTime: new Date(NOW - 3600000 + i * 1000).toISOString() },
      value: { doubleValue: i },
    })).reverse();
  const many = Array.from({ length: 25 }, (_, i) => ({
    metric: { type: "m", labels: { i: String(i) } },
    resource: { type: "cloud_run_revision", labels: { service_name: "svc" } },
    points: points(30),
  }));
  let seen;
  const { tool } = harness({
    routes: {
      [POLICY]: policy,
      "projects/example-prd/timeSeries": (url) => ((seen = url), { timeSeries: many }),
    },
  });
  const r = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 0, ...window });
  assert.equal(seen.searchParams.get("filter"), policy.conditions[0].conditionThreshold.filter);
  assert.equal(seen.searchParams.get("aggregation.perSeriesAligner"), "ALIGN_RATE");
  assert.equal(seen.searchParams.get("aggregation.crossSeriesReducer"), "REDUCE_SUM");
  assert.equal(seen.searchParams.get("aggregation.alignmentPeriod"), "120s");
  assert.equal(r.details.alignmentPeriod, "120s");
  assert.equal(r.details.untrusted.series.length, 20);
  assert.equal(r.details.untrusted.filter, policy.conditions[0].conditionThreshold.filter);
  assert.equal(r.details.seriesOmitted, 5);
  const total = r.details.untrusted.series.reduce((n, s) => n + s.points.length, 0);
  assert.equal(total, 300);
  assert.equal(r.details.pointsOmitted, 600 - 300);
  assert.match(r.details.consoleUrl, /^https:\/\/console\.cloud\.google\.com\/monitoring\/metrics-explorer\?project=example-prd/);
  // oldest dropped first: every returned point is newer than every dropped one
  const times = r.details.untrusted.series.flatMap((s) => s.points.map((p) => p.time)).sort();
  assert.ok(times[0] >= new Date(NOW - 3600000 + 10 * 1000).toISOString());
  const override = await tool.execute("id", { mode: "series", filter: 'metric.type="m"', ...window, alignmentPeriod: 600 });
  assert.equal(override.details.alignmentPeriod, "600s");
  assert.deepEqual(Object.keys(override.details).sort(), ["alignmentPeriod", "consoleUrl", "end", "pointsOmitted", "seriesOmitted", "start", "untrusted"].sort());
});

test("MQL, PromQL and absent conditions", async () => {
  const { tool, calls } = harness({ routes: { [POLICY]: policy, "projects/example-prd/timeSeries": { timeSeries: [] } } });
  const mql = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 1, ...window });
  assert.equal(mql.details.unsupported, "mql");
  assert.equal(mql.details.untrusted.query, "fetch x | rate");
  const prom = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 2, ...window });
  assert.equal(prom.details.unsupported, "promql");
  assert.equal(prom.details.untrusted.query, "up == 0");
  assert.ok(!calls.some((c) => c.url.includes("timeSeries")));
  const absent = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 3, ...window });
  assert.equal(absent.details.alignmentPeriod, "300s");
  assert.equal((await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 9, ...window })).details.error, "condition-not-found");
});

test("403 maps to permission-denied with a hint; other statuses expose no upstream body", async () => {
  const denied = harness({ routes: { "*": { status: 403, body: { error: { message: `secret ${TOKEN}` } } } } });
  const r = await denied.tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.deepEqual(r.details, {
    error: "permission-denied",
    hint: "grant roles/monitoring.viewer on example-prd to reader@example.test",
  });
  for (const [status, error] of [[401, "authentication-failed"], [404, "not-found"], [400, "invalid-request"], [429, "rate-limited"]]) {
    const h = harness({ routes: { "*": { status, body: { error: { message: "LEAK" } } } } });
    const out = await h.tool.execute("id", { mode: "policy", alertPolicy: POLICY });
    assert.equal(out.details.error, error);
    assert.ok(!JSON.stringify(out).includes("LEAK"));
  }
  const five = harness({ routes: { "*": { status: 503, body: {} } } });
  assert.deepEqual((await five.tool.execute("id", { mode: "policy", alertPolicy: POLICY })).details, { error: "upstream-error", status: 503 });
});

test("the access token never appears in output or thrown errors", async () => {
  // Token echoed by upstream content, labels and documentation.
  const leaky = { ...policy, displayName: `n ${TOKEN}`, documentation: { content: `doc ${TOKEN}` } };
  const h = harness({ routes: { [POLICY]: leaky } });
  const r = await h.tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  assert.equal(h.calls[0].used, TOKEN); // used only as the bearer, handed to the HTTP layer
  assert.ok(!h.calls[0].url.includes(TOKEN));
  assert.ok(!h.commands[0].argv.join(" ").includes("access-token=" + TOKEN));
  assert.deepEqual(h.commands[0].argv.slice(1, 4), ["auth", "print-access-token", "--account=reader@example.test"]);
  assert.equal(h.commands[0].opts.baseEnv.CLOUDSDK_CONFIG, "/private/cloud");
  assert.equal(h.commands[0].opts.timeoutMs, 20000);

  const series = harness({ routes: { "*": { timeSeries: [{ metric: { type: "m", labels: { k: TOKEN } }, resource: { type: "r", labels: {} }, points: [] }] } } });
  const s = await series.tool.execute("id", { mode: "series", filter: 'metric.type="m"', ...window });
  assert.ok(!JSON.stringify(s).includes(TOKEN));

  // gcloud failure whose error text contains the token; HTTP layer throwing it too.
  const failing = harness({ gcloudFails: true });
  const out = await failing.tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.equal(out.details.error, "authentication-failed");
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  const throwing = createMetricsTool(config, context, async () => ({ code: 0, stdout: TOKEN }), {
    http: async () => {
      throw new Error(`socket ${TOKEN}`);
    },
    now: () => NOW,
  });
  const t = await throwing.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.equal(t.details.error, "upstream-unavailable");
  assert.ok(!JSON.stringify(t).includes(TOKEN));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(throwing.execute("id", { mode: "policy", alertPolicy: POLICY }, aborted.signal));
  // an unexpected internal exception is replaced with a fixed message
  const weird = createMetricsTool(config, context, async () => ({ code: 0, stdout: TOKEN }), {
    http: async () => ({ status: 200, get text() { throw new Error(`oops ${TOKEN}`); } }),
    now: () => NOW,
  });
  const err = await weird.execute("id", { mode: "policy", alertPolicy: POLICY }).catch((e) => e);
  assert.ok(!String(err?.stack ?? JSON.stringify(err)).includes(TOKEN));
  // a malformed token is rejected rather than sent
  const bad = harness({ token: "x y" });
  assert.equal((await bad.tool.execute("id", { mode: "policy", alertPolicy: POLICY })).details.error, "authentication-failed");
  assert.equal(bad.calls.length, 0);
});

test("only GET requests to monitoring.googleapis.com are attempted by the default transport", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(policy), { status: 200 });
  };
  try {
    const tool = createMetricsTool(config, context, async () => ({ code: 0, stdout: TOKEN }), { now: () => NOW });
    const r = await tool.execute("id", { mode: "policy", alertPolicy: POLICY });
    assert.equal(r.details.policy, POLICY);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[0].init.redirect, "error");
    assert.equal(new URL(seen[0].url).hostname, "monitoring.googleapis.com");
    globalThis.fetch = async () => new Response("x".repeat(3 * 1024 * 1024), { status: 200 });
    const big = await tool.execute("id", { mode: "policy", alertPolicy: POLICY });
    assert.equal(big.details.error, "response-too-large");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const bytes = (r) => Buffer.byteLength(r.content[0].text);

test("every mode stays within the 30 KB result budget", async () => {
  const long = "L".repeat(5000);
  const fat = {
    name: POLICY,
    displayName: long,
    documentation: { content: long },
    conditions: Array.from({ length: 40 }, (_, i) => ({
      displayName: long,
      conditionThreshold: {
        filter: `metric.type="${long}"`,
        comparison: "COMPARISON_GT",
        duration: "60s",
        aggregations: [1, 2, 3, 4].map(() => ({ perSeriesAligner: long, groupByFields: Array(50).fill(long) })),
      },
    })).concat([{ conditionMonitoringQueryLanguage: { query: long.repeat(40), duration: "60s" } }]),
  };
  const labelsOf = () => Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, long]));
  const wide = Array.from({ length: 30 }, () => ({
    metric: { type: "m", labels: labelsOf() },
    resource: { type: "r", labels: labelsOf() },
    points: [{ interval: { endTime: "2026-11-13T10:00:00Z" }, value: { doubleValue: 1 } }],
  }));
  const { tool } = harness({
    routes: { [POLICY]: fat, "projects/example-prd/timeSeries": { timeSeries: wide } },
  });
  const p = await tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.ok(bytes(p) <= 30 * 1024, `policy ${bytes(p)}`);
  assert.ok(p.details.untrusted?.conditions.length <= 10 || p.details.error === "result-too-large");
  const mqlIndex = 40;
  const mql = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: mqlIndex, ...window });
  assert.ok(bytes(mql) <= 30 * 1024, `mql ${bytes(mql)}`);
  assert.equal(mql.details.unsupported, "mql");
  const s = await tool.execute("id", { mode: "series", filter: 'metric.type="m"', ...window });
  assert.ok(bytes(s) <= 30 * 1024, `series ${bytes(s)}`);
  assert.ok(s.details.untrusted?.series.length >= 1 || s.details.error === "result-too-large");
  assert.ok(s.details.seriesOmitted >= 10);
  // Final guard: an oversized result is replaced, never returned.
  const guard = harness({ routes: { [POLICY]: { ...policy, displayName: "x" } } });
  assert.ok(bytes(await guard.tool.execute("id", { mode: "policy", alertPolicy: POLICY })) < 30 * 1024);
});

test("stale invocation errors propagate unchanged, in every phase", async () => {
  for (const failOn of [1, 2, 3, 4]) {
    let n = 0;
    const stale = new Error("stale invocation");
    const ctx = { ...context, assertInvocationCurrent() { if (++n === failOn) throw stale; } };
    const tool = createMetricsTool(config, ctx, async () => ({ code: 0, stdout: TOKEN }), {
      http: async () => ({ status: 200, text: JSON.stringify(policy) }),
      now: () => NOW,
    });
    await assert.rejects(tool.execute("id", { mode: "policy", alertPolicy: POLICY }), (e) => e === stale, `phase ${failOn}`);
  }
});

test("uncertain gcloud cleanup is reported as such, not as an auth failure", async () => {
  for (const error of [Object.assign(new Error("x"), { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" }), Object.assign(new Error("y"), { cleanup: "uncertain" })]) {
    const tool = createMetricsTool(config, context, async () => { throw error; }, { http: async () => assert.fail("no http"), now: () => NOW });
    await assert.rejects(tool.execute("id", { mode: "policy", alertPolicy: POLICY }), /cleanup is uncertain; ask the operator to inspect before retrying/);
  }
});

test("upstream text is under untrusted and redacted; OAuth tokens are redacted", async () => {
  const other = "ya29.OTHER_oauth_token_value_0123456789";
  const leaky = {
    name: POLICY,
    displayName: `n ${other}`,
    documentation: { content: `contact a@b.example ${other}` },
    conditions: [{ displayName: "c", conditionThreshold: { filter: `metric.type="m" AND x="${other}"`, duration: "60s", aggregations: [{ groupByFields: [`f ${other}`] }] } }],
  };
  const { tool } = harness({ routes: { [POLICY]: leaky, "projects/example-prd/timeSeries": { timeSeries: [{ metric: { type: "m", labels: { a: other } }, resource: { type: "r" }, points: [] }] } } });
  const r = await tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.ok(!JSON.stringify(r).includes(other));
  assert.ok(!JSON.stringify(r).includes("a@b.example"));
  const s = await tool.execute("id", { mode: "series", alertPolicy: POLICY, conditionIndex: 0, ...window });
  assert.ok(!JSON.stringify(s).includes(other));
  assert.equal(s.details.consoleUrl, null); // a redacted filter must not be linked
  assert.deepEqual(Object.keys(s.details).sort(), ["alignmentPeriod", "consoleUrl", "end", "pointsOmitted", "seriesOmitted", "start", "untrusted"]);
  assert.equal(redact(`x ${other} y`, {}), "x [REDACTED] y");
});

test("an alert that names a foreign project's policy is refused", async () => {
  for (const name of ["projects/other-prd/alertPolicies/5", "projects/example-prd/alertPolicies/abc", undefined]) {
    const h = harness({ routes: { "projects/example-prd/alerts/0.x": { policy: { name } }, "*": policy } });
    const r = await h.tool.execute("id", { mode: "policy", alertPolicy: "https://console.cloud.google.com/monitoring/alerting/alerts/0.x?project=example-prd" });
    assert.equal(r.details.error, "policy-unresolved");
    assert.equal(h.calls.length, 1);
  }
});

test("a call that exceeds the deadline returns timeout, even if the transport ignores abort", async () => {
  let aborted = false;
  const tool = createMetricsTool(config, context, async () => ({ code: 0, stdout: TOKEN }), {
    http: ({ signal } = {}) => new Promise(() => {}),
    deadlineMs: 30,
    now: () => NOW,
  });
  const r = await tool.execute("id", { mode: "policy", alertPolicy: POLICY });
  assert.deepEqual(r.details, { error: "timeout" });
  // a caller abort is still an abort, not a timeout
  const c = new AbortController();
  const slow = createMetricsTool(config, context, async () => ({ code: 0, stdout: TOKEN }), {
    http: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("x")); })),
    now: () => NOW,
  });
  const pending = slow.execute("id", { mode: "policy", alertPolicy: POLICY }, c.signal);
  setTimeout(() => c.abort(), 10);
  await assert.rejects(pending);
  assert.ok(aborted);
});
