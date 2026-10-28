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
