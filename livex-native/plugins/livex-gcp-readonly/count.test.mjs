import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MAX_CARD_EVIDENCE_URL, buildLogFilter, createLogsTool, queryArgs } from "./core.mjs";
import { createPagedLogsTool } from "./paging.mjs";

const config = {
  gcloudPath: "/opt/google-cloud-sdk/bin/gcloud",
  cloudSdkConfig: "/home/pilot/.config/gcloud",
  gcloudAccount: "investigator@example.test",
  project: "example-prd",
  allowedChannelId: "C123",
  allowedSenderId: "U123",
};
const selector = {
  resourceType: "k8s_container",
  resourceLabels: { cluster_name: "prd-cluster", container_name: "chat-engine" },
};
const HOUR = 3600_000;
const T0 = Date.parse("2026-10-20T10:00:00Z");
const NOW = Date.parse("2026-10-20T20:00:00Z");
const countArgs = (phrases, hours = 3, extra = {}) => ({
  ...selector,
  mode: "count",
  phrases,
  start: new Date(T0).toISOString(),
  end: new Date(T0 + hours * HOUR).toISOString(),
  ...extra,
});
const ctx = (guard = () => {}) => ({
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent: guard,
});
const ok = (rows) => ({
  stdout: JSON.stringify(rows),
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
});
const nanos = (iso) => {
  const [, whole, fraction = ""] = /^(.*?)(?:\.(\d+))?Z$/.exec(iso);
  return BigInt(Date.parse(`${whole}.000Z`)) * 1000000n + BigInt(fraction.padEnd(9, "0"));
};
const quoted = (text) => JSON.stringify(text);

// A gcloud stand-in: serves per-phrase synthetic rows, honouring the filter's phrase and time
// bounds, --order and --limit exactly as `gcloud logging read` would.
function fakeGcloud(rawDataset, { onCall } = {}) {
  const calls = [];
  const ns = new Map();
  const dataset = Object.fromEntries(
    Object.entries(rawDataset).map(([phrase, rows]) => {
      for (const row of rows) ns.set(row, nanos(row.timestamp));
      return [
        phrase,
        rows.toSorted((a, b) =>
          ns.get(a) === ns.get(b) ? a.insertId.localeCompare(b.insertId) : ns.get(a) < ns.get(b) ? -1 : 1,
        ),
      ];
    }),
  );
  const run = async (argv, options) => {
    calls.push({ argv, options });
    if (onCall) {
      const early = await onCall(calls.length, argv, options);
      if (early) return early;
    }
    const filter = argv[3];
    const phrase = Object.keys(dataset).find((key) => filter.includes(`textPayload:${quoted(key)}`));
    const from = nanos(/timestamp>="([^"]+)"/.exec(filter)[1]);
    const to = nanos(/timestamp<="([^"]+)"/.exec(filter)[1]);
    const limit = Number(/--limit=(\d+)/.exec(argv.join(" "))[1]);
    const order = argv.find((a) => a.startsWith("--order=")).slice(8);
    const format = argv.find((a) => a.startsWith("--format=")).slice(9);
    let rows = (dataset[phrase] ?? []).filter((row) => ns.get(row) >= from && ns.get(row) <= to);
    if (order === "desc") rows.reverse();
    rows = rows.slice(0, limit);
    if (format === "json(timestamp,insertId)")
      rows = rows.map(({ timestamp, insertId }) => ({ timestamp, insertId }));
    return ok(rows);
  };
  return { run, calls };
}
const rowsFor = (prefix, count, { spanHours = 3, text } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(T0 + Math.floor((i * spanHours * HOUR) / Math.max(count, 1)) + 1).toISOString(),
    insertId: `${prefix}-${i}`,
    severity: "INFO",
    resource: { type: "k8s_container", labels: { container_name: "chat-engine" } },
    textPayload: text ?? `${prefix} entry ${i}`,
  }));
const make = (dataset, options = {}) => {
  const gcloud = fakeGcloud(dataset, options);
  const tool = createLogsTool(config, options.context ?? ctx(), gcloud.run, {
    now: () => NOW,
    ...options.tool,
  });
  return { tool, ...gcloud };
};

// ------------------------------------------------------------------ textContains

void test("textContains reaches the server-side filter, escaped, and is in logsExplorerUrl", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv[3]);
    return ok([]);
  });
  const base = { ...selector, start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z" };
  const result = await tool.execute("t", { ...base, textContains: "Timeout during LLM language detection" });
  const clause = (text) =>
    `(${[
      "textPayload",
      "jsonPayload.message",
      "jsonPayload.error",
      "jsonPayload.error.message",
      "jsonPayload.error.stack",
      "jsonPayload.stack",
      "jsonPayload.exc_info",
      "jsonPayload.exception",
    ]
      .map((field) => `${field}:${quoted(text)}`)
      .join(" OR ")})`;
  assert.ok(
    calls[0].endsWith(
      `(severity>=ERROR OR jsonPayload.level="error" OR jsonPayload.level="ERROR" OR jsonPayload.levelname="ERROR") AND ${clause("Timeout during LLM language detection")}`,
    ),
  );
  assert.equal(new URL(result.details.logsExplorerUrl).searchParams.get("query"), calls[0]);
  assert.equal(result.details.textContains, "Timeout during LLM language detection");

  // Quotes and backslashes are escaped; the clause stays one balanced group.
  const tricky = 'say "hi" \\ bye OR severity>=INFO';
  const context = await tool.execute("c", { ...base, mode: "context", textContains: tricky });
  assert.ok(calls[1].endsWith(` AND ${clause(tricky)}`));
  assert.ok(calls[1].includes('textPayload:"say \\"hi\\" \\\\ bye OR severity>=INFO"'));
  assert.equal(new URL(context.details.logsExplorerUrl).searchParams.get("query"), calls[1]);
  assert.ok(!calls[1].includes("AND (severity>=ERROR"), "context mode has no severity filter");
  // Without it the filter is unchanged.
  await tool.execute("n", base);
  assert.ok(!calls[2].includes("textPayload:"));
});

void test("textContains validation: length, control characters, mode scope, redaction", async () => {
  const tool = createLogsTool(config, ctx(), async () => ok([]));
  const base = { ...selector, start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z" };
  for (const bad of [
    "ab",
    "  a ",
    "x".repeat(201),
    "line\nbreak",
    "tab\there",
    "nul\u0000x",
    "sep x",
    "bell\u0007x",
    42,
    ["abc"],
    "password=hunter2secret",
    "see https://example.test/a?token=abc",
  ]) {
    await assert.rejects(tool.execute("bad", { ...base, textContains: bad }), /Invalid textContains/u, String(bad));
  }
  await tool.execute("ok-min", { ...base, textContains: "abc" });
  await tool.execute("ok-max", { ...base, textContains: "x".repeat(200) });
  await assert.rejects(
    tool.execute("d", { mode: "discover", insertId: "x", start: base.start, end: base.end, textContains: "abcd" }),
    /Invalid textContains: use only in errors or context mode/u,
  );
  await assert.rejects(
    tool.execute("c", { ...countArgs(["abcd"]), textContains: "abcd" }),
    /Invalid count arguments/u,
  );
  await assert.rejects(tool.execute("p", { ...base, phrases: ["abcd"] }), /Invalid phrases: use only in count mode/u);
  assert.equal(
    buildLogFilter(queryArgs({ ...base, textContains: "abc" }, config), config).includes("textPayload:\"abc\""),
    true,
  );
});

// ------------------------------------------------------------------ count

void test("count returns per-phrase totals and hourly buckets from server-filtered reads", async () => {
  const closing = rowsFor("close", 40);
  const storing = rowsFor("store", 25);
  const { tool, calls } = make({ "[PHONE_CLOSE] Closing conversation": closing, "Storing phone call data": storing, "[PHONE_CLOSE] Close request failed": [] });
  const phrases = ["[PHONE_CLOSE] Closing conversation", "Storing phone call data", "[PHONE_CLOSE] Close request failed"];
  const result = await tool.execute("count", countArgs(phrases));
  const d = result.details;
  assert.equal(d.mode, "count");
  assert.equal(d.complete, true);
  assert.equal(d.incompleteReasons, undefined);
  assert.deepEqual(d.totals, { [phrases[0]]: 40, [phrases[1]]: 25, [phrases[2]]: 0 });
  assert.equal(d.scanned, 65);
  assert.deepEqual(d.window, { start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T13:00:00.000Z" });
  assert.equal(d.buckets.length, 3);
  assert.deepEqual(
    d.buckets.map((b) => [b.start, b.end]),
    [
      ["2026-10-20T10:00:00.000Z", "2026-10-20T11:00:00.000Z"],
      ["2026-10-20T11:00:00.000Z", "2026-10-20T12:00:00.000Z"],
      ["2026-10-20T12:00:00.000Z", "2026-10-20T13:00:00.000Z"],
    ],
  );
  for (const phrase of phrases) {
    assert.equal(d.buckets.reduce((sum, b) => sum + b.counts[phrase], 0), d.totals[phrase], phrase);
  }
  // 40 rows spread evenly over 3 hours: 14/13/13.
  assert.deepEqual(d.buckets.map((b) => b.counts[phrases[0]]), [14, 13, 13]);
  // Three long phrases over nine text fields exceed the card's link limit, so no overview link is offered.
  assert.equal(d.logsExplorerUrl, undefined);
  assert.equal(d.logsExplorerLinkUnavailableReason, "url-too-long");
  assert.ok(d.samples.every((sample) => sample.entryUrl));
  assert.equal(result.content[0].text, JSON.stringify(d));
  assert.match(d.note, /Untrusted log evidence/u);
  // Every read is a filtered gcloud read of the configured project, capped by --limit.
  for (const { argv } of calls) {
    assert.equal(argv[1], "logging");
    assert.ok(argv.includes("--project=example-prd"));
    assert.ok(argv[3].startsWith('logName =~ "^projects/example-prd/logs/" AND resource.type="k8s_container"'));
  }
});

void test("count filter text, with the dedicated phrase clause and no severity filter", async () => {
  const { tool, calls } = make({});
  await tool.execute("f", countArgs(["Storing phone call data", "[PHONE_CLOSE] Closing conversation"], 3));
  const terms = (text) =>
    [
      "textPayload",
      "jsonPayload.message",
      "jsonPayload.error",
      "jsonPayload.error.message",
      "jsonPayload.error.stack",
      "jsonPayload.stack",
      "jsonPayload.exc_info",
      "jsonPayload.exception",
    ]
      .map((field) => `${field}:${quoted(text)}`)
      .join(" OR ");
  const prefix =
    'logName =~ "^projects/example-prd/logs/" AND resource.type="k8s_container" AND resource.labels.cluster_name="prd-cluster" AND resource.labels.container_name="chat-engine" AND timestamp>="2026-10-20T10:00:00.000Z" AND timestamp<="2026-10-20T13:00:00.000Z" AND ';
  assert.equal(calls[0].argv[3], `${prefix}(${terms("Storing phone call data")})`);
  assert.equal(calls[1].argv[3], `${prefix}(${terms("[PHONE_CLOSE] Closing conversation")})`);
  assert.ok(!calls[0].argv[3].includes("severity"));
});

void test("count samples: at most three per phrase, newest first, entryUrl, redacted trimmed text", async () => {
  const rows = rowsFor("close", 9, { text: "x" });
  rows[8].textPayload = `  Closing conversation token=abc123secret for jane@example.test ${"y".repeat(500)}  `;
  const { tool } = make({ "Closing conversation": rows, "Storing phone call data": rowsFor("store", 2) });
  const { details: d } = await tool.execute("s", countArgs(["Closing conversation", "Storing phone call data"]));
  const closing = d.samples.filter((s) => s.phrase === "Closing conversation");
  const storing = d.samples.filter((s) => s.phrase === "Storing phone call data");
  assert.equal(closing.length, 3);
  assert.equal(storing.length, 2, "a phrase with two matches has exactly those two samples");
  assert.deepEqual(closing.map((s) => s.insertId), ["close-8", "close-7", "close-6"]);
  assert.equal(d.totals["Storing phone call data"], 2);
  for (const sample of d.samples) {
    assert.match(sample.entryUrl, /^https:\/\/console\.cloud\.google\.com\/logs\/query\?project=example-prd&query=/u);
    assert.equal(
      new URL(sample.entryUrl).searchParams.get("query").startsWith(`insertId=${quoted(sample.insertId)} AND timestamp>=`),
      true,
    );
    assert.ok(sample.text.length <= 300);
  }
  const redacted = closing[0].text;
  assert.ok(redacted.startsWith("Closing conversation token=[REDACTED] for [REDACTED] "), redacted);
  assert.ok(!redacted.includes("abc123secret") && !redacted.includes("jane@"));
  assert.equal(redacted, redacted.trim());
});

void test("count argument validation", async () => {
  const { tool, calls } = make({});
  const bad = async (args, pattern) => assert.rejects(tool.execute("bad", args), pattern);
  await bad(countArgs(["abcd"], 7), /Invalid query window: use at most 6 hours/u);
  await bad({ ...countArgs(["abcd"]), end: "2026-10-20T10:00:00Z" }, /Invalid query window/u);
  await bad(countArgs(Array.from({ length: 6 }, (_, i) => `phrase ${i}`)), /Invalid phrases: use 1 to 5/u);
  await bad(countArgs([]), /Invalid phrases: use 1 to 5/u);
  await bad({ ...countArgs(["abcd"]), phrases: "abcd" }, /Invalid phrases: use 1 to 5/u);
  await bad(countArgs(["abcd", "abcd"]), /remove duplicates/u);
  await bad(countArgs(["ab"]), /Invalid phrases/u);
  await bad(countArgs(["x".repeat(201)]), /Invalid phrases/u);
  await bad(countArgs(["a\nb c"]), /Invalid phrases/u);
  await bad(countArgs(["secret=abcd1234"]), /Invalid phrases/u);
  await bad({ ...countArgs(["abcd"]), limit: 5 }, /Invalid count arguments/u);
  await bad({ ...countArgs(["abcd"]), errorProfile: "tab-delimited" }, /Invalid count arguments/u);
  await bad({ ...countArgs(["abcd"]), conversationId: "c1" }, /Invalid count arguments/u);
  await bad({ ...countArgs(["abcd"]), resourceType: undefined }, /Invalid resourceType/u);
  await bad({ ...countArgs(["abcd"]), resourceLabels: { project_id: "other-prd" } }, /project_id/u);
  await bad({ ...countArgs(["abcd"]), resourceLabels: {} }, /Invalid resourceLabels/u);
  // 5 minutes into the future is the existing metrics tolerance.
  const future = new Date(NOW + 6 * 60_000).toISOString();
  await bad({ ...countArgs(["abcd"]), start: new Date(NOW - HOUR).toISOString(), end: future }, /future/u);
  await tool.execute("edge", {
    ...countArgs(["abcd"]),
    start: new Date(NOW - HOUR).toISOString(),
    end: new Date(NOW + 5 * 60_000).toISOString(),
  });
  // Exactly six hours is allowed and has six buckets.
  const six = await tool.execute("six", countArgs(["abcd"], 6));
  assert.equal(six.details.buckets.length, 6);
  assert.equal(calls.length, 2, "rejected calls never reach gcloud");
});

void test("a scan cap returns lower bounds with complete:false, shared fairly across phrases", async () => {
  const a = rowsFor("a", 4000, { spanHours: 6 });
  const b = rowsFor("b", 4000, { spanHours: 6 });
  const { tool, calls } = make({ "alpha phrase": a, "bravo phrase": b });
  const { details: d } = await tool.execute("cap", countArgs(["alpha phrase", "bravo phrase"], 6));
  assert.equal(d.complete, false);
  assert.deepEqual(d.incompleteReasons, ["scan-cap"]);
  assert.equal(d.scanned, 5000);
  const totals = Object.values(d.totals);
  assert.equal(totals[0] + totals[1], 5000);
  assert.ok(totals.every((n) => n >= 2000 && n < 4000), JSON.stringify(totals));
  assert.match(d.note, /LOWER BOUND/u);
  assert.ok(calls.every(({ options }) => options.maxOutputBytes.stdout === 256 * 1024));
  // Counted rows are never counted twice across reads.
  assert.equal(d.buckets.reduce((sum, bucket) => sum + bucket.counts["alpha phrase"] + bucket.counts["bravo phrase"], 0), 5000);
});

void test("a window with exactly the cap of matches is complete only if every phrase finished", async () => {
  const { tool } = make({ "alpha phrase": rowsFor("a", 1200, { spanHours: 3 }) });
  const { details: d } = await tool.execute("n", countArgs(["alpha phrase"]));
  assert.equal(d.complete, true);
  assert.equal(d.totals["alpha phrase"], 1200);
  assert.equal(d.scanned, 1200);
});

void test("rows sharing a timestamp across page boundaries are counted once", async () => {
  const same = Array.from({ length: 500 }, (_, i) => ({
    timestamp: "2026-10-20T10:30:00.123456789Z",
    insertId: `tie-${String(i).padStart(4, "0")}`,
  }));
  const after = rowsFor("later", 20, { spanHours: 2 }).map((row, i) => ({ ...row, timestamp: `2026-10-20T11:${String(i + 10).padStart(2, "0")}:00Z` }));
  const { tool } = make({ "tied phrase": [...same, ...after] });
  const { details: d } = await tool.execute("tie", countArgs(["tied phrase"]));
  assert.equal(d.totals["tied phrase"], 520);
  assert.equal(d.complete, true);
  // A page made only of already counted rows cannot advance: lower bound, not a loop.
  const dense = Array.from({ length: 900 }, (_, i) => ({ timestamp: "2026-10-20T10:30:00Z", insertId: `d-${i}` }));
  const stuck = make({ "dense phrase": dense }, { tool: {} });
  const stuckResult = await stuck.tool.execute("dense", countArgs(["dense phrase"]));
  assert.equal(stuckResult.details.totals["dense phrase"], 800);
  assert.equal(stuckResult.details.complete, false);
  assert.deepEqual(stuckResult.details.incompleteReasons, ["dense-timestamp"]);
});

void test("the 60 second deadline returns what was counted with complete:false and kills the read", async () => {
  let aborted = false;
  const { tool, calls } = make(
    { "alpha phrase": rowsFor("a", 3000), "bravo phrase": rowsFor("b", 3000) },
    {
      tool: { deadlineMs: 80 },
      onCall: async (n, _argv, options) => {
        if (n < 5) return undefined;
        // The fifth read hangs until the deadline kills it.
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        aborted = true;
        return { stdout: "", stderr: "", code: null, signal: "SIGTERM", killed: true, killIssuedByAbort: true, termination: "signal" };
      },
    },
  );
  const { details: d } = await tool.execute("deadline", countArgs(["alpha phrase", "bravo phrase"]));
  assert.equal(aborted, true);
  assert.equal(calls.length, 5);
  assert.equal(d.complete, false);
  assert.deepEqual(d.incompleteReasons, ["deadline"]);
  assert.ok(d.totals["alpha phrase"] >= 800 && d.totals["alpha phrase"] < 3000);
  assert.match(d.note, /LOWER BOUND/u);
  assert.equal(calls.at(-1).options.timeoutMs <= 80, true, "a read never outlives the remaining deadline");
});

void test("a deadline that finds cleanup uncertain is an error, not partial counts", async () => {
  const { tool } = make(
    { "alpha phrase": rowsFor("a", 3000) },
    {
      tool: { deadlineMs: 50 },
      onCall: async (n, _argv, options) => {
        if (n < 2) return undefined;
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        throw Object.assign(new Error("boom"), { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      },
    },
  );
  await assert.rejects(tool.execute("u", countArgs(["alpha phrase"])), /cleanup is uncertain/u);
  const uncertain = make({}, { onCall: async () => ({ ...ok([]), cleanup: "uncertain" }) });
  await assert.rejects(uncertain.tool.execute("u2", countArgs(["alpha phrase"])), /cleanup is uncertain/u);
});

void test("read failures stay errors with fixed messages and no diagnostics", async () => {
  const failing = make({}, { onCall: async () => ({ ...ok([]), code: 1, stderr: "secret diagnostics" }) });
  await assert.rejects(failing.tool.execute("f", countArgs(["alpha phrase"])), /exited with code 1/u);
  const crashed = createLogsTool(config, ctx(), async () => {
    throw new Error("secret path /home/x");
  });
  await assert.rejects(crashed.execute("c", countArgs(["alpha phrase"])), (error) => {
    assert.match(error.message, /could not complete/u);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  const overflow = make({}, { onCall: async () => ({ ...ok([]), outputLimitExceeded: true }) });
  await assert.rejects(overflow.tool.execute("o", countArgs(["alpha phrase"])), /output limit/u);
});

void test("a stale invocation is rethrown unchanged, before and during a count", async () => {
  const stale = new Error("invocation superseded");
  let current = true;
  const guard = () => {
    if (!current) throw stale;
  };
  const gcloud = fakeGcloud({ "alpha phrase": rowsFor("a", 2000) }, {
    onCall: async (n) => {
      if (n === 2) current = false;
      return undefined;
    },
  });
  const tool = createLogsTool(config, ctx(guard), gcloud.run, { now: () => NOW });
  await assert.rejects(tool.execute("s", countArgs(["alpha phrase"])), (error) => error === stale);
  assert.equal(gcloud.calls.length, 2, "no further reads after the invocation went stale");
  const before = fakeGcloud({});
  await assert.rejects(tool.execute("s2", countArgs(["alpha phrase"])), (error) => error === stale);
  assert.equal(before.calls.length, 0);
  // A caller abort surfaces as the abort reason, never as partial counts.
  const controller = new AbortController();
  const reason = new Error("caller aborted");
  const abortable = make({ "alpha phrase": rowsFor("a", 2000) }, {
    onCall: async (n) => {
      if (n === 2) controller.abort(reason);
      return undefined;
    },
  });
  await assert.rejects(abortable.tool.execute("a", countArgs(["alpha phrase"]), controller.signal), (error) => error === reason);
});

void test("only the authorized caller gets the tool; count needs the same gate", () => {
  for (const context of [
    { ...ctx(), requesterSenderId: "UOTHER" },
    { ...ctx(), nativeChannelId: "C999" },
    { ...ctx(), messageChannel: "discord" },
    { ...ctx(), assertInvocationCurrent: undefined },
  ]) {
    assert.equal(createLogsTool(config, context, async () => ok([])), null);
  }
});

void test("count results stay within the byte budget even for five 200-character phrases", async () => {
  const phrases = Array.from({ length: 5 }, (_, i) => `${String(i)}${"p".repeat(199)}`.replaceAll('"', "q"));
  const dataset = Object.fromEntries(
    phrases.map((phrase, i) => [phrase, rowsFor(`row${i}`, 30, { spanHours: 6, text: `${"long sample text ".repeat(40)}` })]),
  );
  const { tool } = make(dataset);
  const result = await tool.execute("big", countArgs(phrases, 6));
  assert.ok(Buffer.byteLength(result.content[0].text) <= 30 * 1024, String(Buffer.byteLength(result.content[0].text)));
  assert.equal(result.details.complete, true);
  assert.equal(result.details.buckets.length, 6);
  for (const phrase of phrases) assert.equal(result.details.totals[phrase], 30);
  // The same with quotes and backslashes that double when JSON-escaped.
  const escapedPhrases = Array.from({ length: 5 }, (_, i) => `"\\${String(i)}`.padEnd(200, '"'));
  const escaped = make(Object.fromEntries(escapedPhrases.map((phrase, i) => [phrase, rowsFor(`e${i}`, 10)])));
  const escapedResult = await escaped.tool.execute("big2", countArgs(escapedPhrases, 6));
  assert.ok(Buffer.byteLength(escapedResult.content[0].text) <= 30 * 1024);
  for (const phrase of escapedPhrases) assert.equal(escapedResult.details.totals[phrase], 10);
});

void test("worst-case read count for a 6 hour, 3 phrase count", async () => {
  // Adversarial sizes: phrases that each finish on an exact page multiple cost one extra empty
  // read, and the shared 5000-entry cap ends the rest.
  let worst = 0;
  const sizes = [0, 2, 3, 799, 800, 1600, 1667, 2400, 5000];
  for (const x of sizes) {
    for (const y of sizes) {
      for (const z of sizes) {
        const { tool, calls } = make(
          {
            "phrase one": rowsFor("one", x, { spanHours: 6 }),
            "phrase two": rowsFor("two", y, { spanHours: 6 }),
            "phrase three": rowsFor("three", z, { spanHours: 6 }),
          },
        );
        const { details } = await tool.execute("w", countArgs(["phrase one", "phrase two", "phrase three"], 6));
        assert.ok(details.scanned <= 5000);
        worst = Math.max(worst, calls.length);
      }
    }
  }
  assert.ok(worst <= 13, `worst case was ${worst}`);
  console.log(`# worst-case gcloud reads for 3 phrases over 6 hours: ${worst}`);
});

void test("the paged tool routes count to the same bounded reader and leaves other modes alone", async () => {
  const gcloud = fakeGcloud({ "alpha phrase": rowsFor("a", 5) });
  const ledger = {
    async getCursor() {
      throw new Error("count must not touch the ledger");
    },
    async reserveQuery() {
      throw new Error("count must not touch the ledger");
    },
  };
  const tool = createPagedLogsTool(config, ctx(), gcloud.run, {
    ledger,
    readPage: async () => {
      throw new Error("count must not use the page reader");
    },
    now: () => NOW,
  });
  assert.ok(tool.parameters.properties.mode.enum.includes("count"));
  assert.ok(tool.parameters.properties.phrases && tool.parameters.properties.textContains);
  assert.match(tool.description, /mode=count/u);
  const { details } = await tool.execute("p", countArgs(["alpha phrase"]));
  assert.equal(details.totals["alpha phrase"], 5);
  await assert.rejects(tool.execute("p2", { ...countArgs(["alpha phrase"]), cursor: "a".repeat(64) }), /Invalid query arguments/u);
});

void test("tool description and schema document both features and lower bounds", () => {
  const tool = createLogsTool(config, ctx(), async () => ok([]));
  assert.match(tool.description, /textContains/u);
  assert.match(tool.description, /mode=count/u);
  assert.match(tool.description, /complete=false/u);
  assert.match(tool.description, /LOWER BOUND/u);
  assert.match(tool.description, /samples\[\]\.entryUrl/u);
  assert.deepEqual(tool.parameters.properties.mode.enum, ["errors", "context", "discover", "count"]);
  assert.equal(tool.parameters.properties.phrases.maxItems, 5);
  assert.equal(tool.parameters.properties.textContains.minLength, 3);
  assert.equal(tool.parameters.properties.textContains.maxLength, 200);
  assert.equal(tool.parameters.additionalProperties, false);
});

void test("tab-delimited profile sends single-backslash \\t to gcloud and the Logs Explorer link", async () => {
  const expected = String.raw`((jsonPayload:* AND severity>=ERROR) OR textPayload =~ "^[^\t]+\t(ERROR|DPANIC|PANIC|FATAL)\t")`;
  assert.equal(expected.split("\\").length - 1, 3, "three backslashes, one per t");
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return ok([]);
  });
  const { details } = await tool.execute("tab", {
    ...selector,
    start: "2026-10-20T10:00:00Z",
    end: "2026-10-20T10:30:00Z",
    errorProfile: "tab-delimited",
  });
  assert.ok(calls[0][3].endsWith(` AND ${expected}`));
  assert.ok(!calls[0][3].includes(String.raw`\\t`));
  assert.equal(new URL(details.logsExplorerUrl).searchParams.get("query"), calls[0][3]);
  assert.ok(details.logsExplorerUrl.includes("%5C%5Ct") === false);
  assert.ok(details.logsExplorerUrl.includes("%5Ct%5D%2B%5Ct%28ERROR%7CDPANIC%7CPANIC%7CFATAL%29%5Ct"));
  const built = buildLogFilter(queryArgs({ ...selector, start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z", errorProfile: "tab-delimited" }, config), config);
  assert.ok(built.endsWith(` AND ${expected}`));
});

// ------------------------------------------------------------------ agentId

// Serves rows whose filter carries the agent_id clause; asserts nothing about phrases.
function agentGcloud(rows) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    const filter = argv[3];
    const from = nanos(/timestamp>="([^"]+)"/.exec(filter)[1]);
    const to = nanos(/timestamp<="([^"]+)"/.exec(filter)[1]);
    const limit = Number(/--limit=(\d+)/.exec(argv.join(" "))[1]);
    const order = argv.find((a) => a.startsWith("--order=")).slice(8);
    let found = filter.includes('jsonPayload.agent_id="agent-1"')
      ? rows.filter((row) => nanos(row.timestamp) >= from && nanos(row.timestamp) <= to)
      : [];
    if (order === "desc") found = found.toReversed();
    return ok(found.slice(0, limit));
  };
  return { run, calls };
}

void test("count with agentId alone totals every entry of that agent under the key *", async () => {
  const rows = rowsFor("a", 7, { spanHours: 3, text: "no mention of the id" });
  const gcloud = agentGcloud(rows);
  const tool = createLogsTool(config, ctx(), gcloud.run, { now: () => NOW });
  const args = { ...countArgs(undefined, 3), agentId: "agent-1" };
  delete args.phrases;
  const { details } = await tool.execute("c", args);
  assert.deepEqual(details.totals, { "*": 7 });
  assert.equal(details.agentId, "agent-1");
  assert.equal(details.complete, true);
  assert.equal(details.buckets.reduce((sum, bucket) => sum + bucket.counts["*"], 0), 7);
  assert.ok(details.buckets.every((bucket) => Object.keys(bucket.counts).join() === "*"));
  for (const argv of gcloud.calls) {
    assert.ok(argv[3].includes(' AND jsonPayload.agent_id="agent-1"'));
    assert.ok(!argv[3].includes("textPayload:"), "no phrase clause");
  }
  assert.equal(
    new URL(details.logsExplorerUrl).searchParams.get("query"),
    buildLogFilter(queryArgs(args, config, { now: () => NOW }), config),
  );
  assert.equal(details.samples.length, 3);
});

void test("count with agentId and phrases requires both on every phrase filter", async () => {
  const gcloud = agentGcloud([]);
  const tool = createLogsTool(config, ctx(), gcloud.run, { now: () => NOW });
  await tool.execute("c", countArgs(["timeout", "failed"], 3, { agentId: "agent-1" }));
  assert.ok(gcloud.calls.length >= 2);
  for (const argv of gcloud.calls) {
    assert.ok(argv[3].includes(' AND jsonPayload.agent_id="agent-1" AND (textPayload:'));
  }
  // An empty phrase list with an agent is the same as none.
  const none = await tool.execute("e", countArgs([], 3, { agentId: "agent-1" }));
  assert.deepEqual(Object.keys(none.details.totals), ["*"]);
});

void test("count agentId validation", async () => {
  const tool = createLogsTool(config, ctx(), async () => ok([]), { now: () => NOW });
  await assert.rejects(tool.execute("n", { ...countArgs(undefined) }), /Invalid phrases/u);
  await assert.rejects(tool.execute("e", countArgs([])), /Invalid phrases/u);
  for (const bad of ["", "   ", "x".repeat(257), "a\nb", 5, ["a"]]) {
    await assert.rejects(
      tool.execute("b", countArgs(undefined, 3, { agentId: bad })),
      /Invalid agentId|Invalid phrases/u,
      String(bad),
    );
  }
  const base = { ...selector, start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z" };
  await assert.rejects(tool.execute("m", { ...base, agentId: "agent-1" }), /Invalid agentId: use only in count mode/u);
  assert.equal(tool.parameters.properties.agentId.type, "string");
  assert.match(tool.description, /agentId/u);
  assert.equal(tool.parameters.additionalProperties, false);
});

// ------------------------------------------------------------------ exception field

void test("jsonPayload.exception is projected, returned and searchable", async () => {
  const calls = [];
  const traceback = "Traceback (most recent call last):\n  File x.py, line 1\nValueError: boom";
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return ok([
      {
        timestamp: "2026-10-20T10:01:00Z",
        insertId: "e1",
        severity: "ERROR",
        resource: { type: "k8s_container", labels: { container_name: "chat-engine" } },
        jsonPayload: { level: "error", exception: traceback },
      },
    ]);
  });
  const { details } = await tool.execute("x", {
    ...selector,
    start: "2026-10-20T10:00:00Z",
    end: "2026-10-20T10:30:00Z",
    textContains: "ValueError: boom",
  });
  assert.ok(calls[0].find((a) => a.startsWith("--format=")).includes("jsonPayload.exception"));
  assert.ok(calls[0][3].includes('jsonPayload.exception:"ValueError: boom"'));
  assert.equal(details.entries[0].jsonPayload.exception, traceback);
});

// ------------------------------------------------------------------ card link limit

void test("logsExplorerUrl above the card limit is omitted as url-too-long; short ones stay", async () => {
  const tool = createLogsTool(config, ctx(), async () => ok([]), { now: () => NOW });
  const longPhrases = Array.from({ length: 5 }, (_, i) => `${String(i).repeat(1)}${"w".repeat(150)}`);
  const long = await tool.execute("l", countArgs(longPhrases));
  assert.equal(long.details.logsExplorerUrl, undefined);
  assert.equal(long.details.logsExplorerLinkUnavailableReason, "url-too-long");
  const short = await tool.execute("s", countArgs(["timeout"]));
  const href = short.details.logsExplorerUrl;
  assert.ok(href.replaceAll("&", "&amp;").length <= MAX_CARD_EVIDENCE_URL);
  // The limit is the card's: the same constant value the Slack summary enforces.
  const summarySource = readFileSync(new URL("../livex-slack-summary/core.mjs", import.meta.url), "utf8");
  assert.equal(
    Number(/^const MAX_EVIDENCE_URL = (\d+);/mu.exec(summarySource)[1]),
    MAX_CARD_EVIDENCE_URL,
  );
  // Entry links stay far below it.
  const row = {
    timestamp: "2026-10-20T10:01:00Z",
    insertId: "i".repeat(200),
    severity: "ERROR",
    resource: { type: "k8s_container", labels: {} },
    textPayload: "x",
  };
  const read = createLogsTool(config, ctx(), async () => ok([row]));
  const { details } = await read.execute("r", {
    ...selector,
    start: "2026-10-20T10:00:00Z",
    end: "2026-10-20T10:30:00Z",
  });
  assert.ok(details.entries[0].entryUrl.length < MAX_CARD_EVIDENCE_URL);
});
