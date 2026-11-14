import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogsTool, queryArgs, withEvidenceLink } from "./core.mjs";

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
const query = {
  mode: "discover",
  insertIds: ['seed "quoted" & #;=+(one)', "unicode-雪"],
  start: "2026-10-20T16:00:46.073712001Z",
  end: "2026-10-20T17:00:46.073712001Z",
  limit: 1,
};
const success = { code: 0, termination: "exit", killed: false, stdout: "[]", stderr: "" };

test("evidence URL opens the exact admitted filter and project, preserving fractional times and reserved characters", async () => {
  const calls = [];
  const tool = createLogsTool(config, context, async (argv) => {
    calls.push(argv);
    return success;
  });
  const { details } = await tool.execute("query", query);
  const url = new URL(details.logsExplorerUrl);
  assert.equal(url.origin, "https://console.cloud.google.com");
  assert.equal(url.pathname, "/logs/query");
  assert.equal(url.searchParams.get("project"), "example-prd");
  assert.equal(url.searchParams.get("query"), calls[0][3]);
  assert.deepEqual([...url.searchParams.keys()], ["project", "query"]);
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.get("query").includes(".073712001Z"), true);
  assert.equal(calls.length, 1);
  assert.ok(!decodeURIComponent(details.logsExplorerUrl).includes(config.gcloudAccount));
});

test("redacted selectors never leak through an encoded evidence URL or link to a different filter", async () => {
  const tool = createLogsTool(config, context, async () => success);
  for (const params of [
    { ...query, insertIds: ["token=PRIVATE_QUERY_SECRET"] },
    {
      mode: "context",
      resourceType: "k8s_container",
      resourceLabels: { token: "PRIVATE_QUERY_SECRET" },
      start: query.start,
      end: query.end,
    },
  ]) {
    const { details } = await tool.execute("redacted", params);
    assert.equal(details.logsExplorerUrl, undefined);
    assert.equal(details.logsExplorerLinkUnavailableReason, "query-redacted");
    assert.ok(!JSON.stringify(details).includes("PRIVATE_QUERY_SECRET"));
  }
});

test("long links are omitted without truncating the executed query or failing evidence delivery", async () => {
  let sent;
  const tool = createLogsTool(config, context, async (argv) => {
    sent = argv[3];
    return success;
  });
  const labels = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => ["label" + i, "雪".repeat(100)]),
  );
  const { details } = await tool.execute("long", {
    mode: "context",
    resourceType: "k8s_container",
    resourceLabels: labels,
    start: query.start,
    end: query.end,
  });
  assert.ok(sent.includes("雪".repeat(100)));
  assert.equal(details.logsExplorerUrl, undefined);
  assert.equal(details.logsExplorerLinkUnavailableReason, "url-too-long");
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 30 * 1024);
});

test("a near-full cached receipt keeps its rows and cursor instead of overflowing for a link", () => {
  const details = {
    entries: [{ message: "x".repeat(30 * 1024 - 150) }],
    nextCursor: "opaque-cursor",
    reusedEvidence: true,
  };
  const before = JSON.stringify(details);
  const linked = withEvidenceLink(details, queryArgs(query, config), config);
  assert.equal(linked.logsExplorerUrl, undefined);
  assert.equal(linked.logsExplorerLinkUnavailableReason, "result-byte-limit");
  assert.ok(Buffer.byteLength(JSON.stringify(linked)) <= 30 * 1024);
  assert.deepEqual(linked.entries, details.entries);
  assert.equal(linked.nextCursor, details.nextCursor);
  assert.equal(JSON.stringify(details), before);
});

const rowsResult = (rows) => ({ ...success, stdout: JSON.stringify(rows) });
const readRows = async (rows, limit = 50) => {
  const tool = createLogsTool(config, context, async () => rowsResult(rows));
  const { details } = await tool.execute("rows", { ...query, insertIds: undefined, insertId: "x", limit });
  return details;
};

test("each entry gets an entryUrl for exactly that insertId with +-1s timestamp bounds", async () => {
  const details = await readRows([
    { insertId: 'a"b\\c', timestamp: "2026-11-14T09:12:05.250Z", severity: "ERROR", textPayload: "boom" },
  ]);
  const url = new URL(details.entries[0].entryUrl);
  assert.equal(url.origin + url.pathname, "https://console.cloud.google.com/logs/query");
  assert.deepEqual([...url.searchParams.keys()], ["project", "query"]);
  assert.equal(url.searchParams.get("project"), "example-prd");
  assert.equal(
    url.searchParams.get("query"),
    'insertId="a\\"b\\\\c" AND timestamp>="2026-11-14T09:12:04.250Z" AND timestamp<="2026-11-14T09:12:06.250Z"',
  );
  assert.ok(details.entries[0].entryUrl.includes("%22"));
  assert.ok(!details.entries[0].entryUrl.includes('"'));
  assert.equal(details.entryUrlsOmitted, undefined);
});

test("entryUrl is omitted when the insertId or timestamp is missing, invalid or redacted", async () => {
  const details = await readRows([
    { insertId: "token=PRIVATE_ID_SECRET", timestamp: "2026-11-14T09:12:05Z" },
    { insertId: "ok1" },
    { insertId: "ok2", timestamp: "not-a-date" },
    { timestamp: "2026-11-14T09:12:05Z" },
    { insertId: "x".repeat(2000), timestamp: "2026-11-14T09:12:05Z" },
  ]);
  assert.equal(details.entries.length, 5);
  for (const entry of details.entries) assert.equal(entry.entryUrl, undefined);
  assert.ok(!JSON.stringify(details).includes("PRIVATE_ID_SECRET"));
});

test("byte-limit pressure drops entryUrls from the oldest entries first and flags the count", async () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    insertId: "id" + i,
    timestamp: `2026-11-14T09:12:${String(50 - i).padStart(2, "0")}Z`, // id0 newest
    severity: "ERROR",
    textPayload: "m".repeat(1900),
  }));
  const details = await readRows(rows);
  assert.equal(details.entries.length, 14);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 30 * 1024);
  assert.equal(details.entryUrlsOmitted, 7);
  assert.deepEqual(
    details.entries.filter((e) => e.entryUrl).map((e) => e.insertId),
    ["id0", "id1", "id2", "id3", "id4", "id5", "id6"],
  );
});
