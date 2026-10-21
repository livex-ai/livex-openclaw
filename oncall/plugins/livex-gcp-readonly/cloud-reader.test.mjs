import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudPageReader, createPagedLogsTool } from "./paging.mjs";

const config = {
  gcloudPath: "/sdk/bin/gcloud",
  cloudSdkConfig: "/private/cloud",
  gcloudAccount: "reader@example.test",
  project: "example-prd",
  allowedSenderId: "U123",
  allowedChannelId: "*",
  paging: { enabled: true, pythonPath: "/usr/bin/python3", sdkRoot: "/sdk" },
};
const query = {
  mode: "discover",
  insertIds: ["fixture-seed"],
  start: "2026-10-20T16:00:46.073712Z",
  end: "2026-10-20T17:00:46.073712Z",
  limit: 1,
};
const success = {
  code: 0,
  termination: "exit",
  killed: false,
  stdout: JSON.stringify({ entries: [], nextPageToken: "opaque-next", projectionTruncated: false }),
  stderr: "",
};
const secret = "PRIVATE_TOKEN_AND_REQUEST_BODY";
const httpFailure = (status) => ({
  ...success,
  code: 1,
  stdout: "",
  stderr:
    JSON.stringify({ error: { code: "http_error", httpStatus: status, message: secret } }) + "\n",
});

test("cloud reader reports HTTP request and access failures without SDK body disclosure", async () => {
  for (const [status, expected] of [
    [400, /HTTP 400.*field selection/i],
    [401, /HTTP 401.*authentication/i],
    [403, /HTTP 403.*access/i],
    [429, /HTTP 429.*quota/i],
    [503, /HTTP 503.*service/i],
  ]) {
    const reader = createCloudPageReader(config, async () => httpFailure(status));
    await assert.rejects(
      reader(query),
      (error) =>
        expected.test(error.message) &&
        !error.message.includes(secret) &&
        /no cursor was advanced/.test(error.message),
    );
  }
});

test("cloud reader distinguishes process failures and gives cleanup uncertainty precedence", async () => {
  const failures = [
    [{ termination: "timeout", code: 124, killed: true }, /timed out after 30 seconds/i],
    [{ termination: "no-output-timeout", code: 124, killed: true }, /timed out/i],
    [
      { outputLimitExceeded: true, termination: "signal", killIssuedByAbort: true },
      /output limit/i,
    ],
    [{ stdoutTruncatedBytes: 1 }, /output limit/i],
    [{ stderrTruncatedBytes: 1 }, /output limit/i],
    [{ outputErrorStream: "stderr" }, /output could not be captured/i],
    [{ termination: "signal", killIssuedByAbort: true }, /cancelled/i],
    [
      { cleanup: "uncertain", outputLimitExceeded: true, termination: "timeout" },
      /cleanup is uncertain/i,
    ],
  ];
  for (const [result, expected] of failures) {
    const reader = createCloudPageReader(config, async () => ({
      ...success,
      ...result,
      stderr: secret,
    }));
    await assert.rejects(
      reader(query),
      (error) => expected.test(error.message) && !error.message.includes(secret),
    );
  }
});

test("unrecognized helper failures stay generic and successful pages retain their continuation", async () => {
  for (const stderr of [
    secret,
    JSON.stringify({ error: { code: "sdk_error", message: secret } }),
    JSON.stringify({ error: { code: "http_error", httpStatus: "400 " + secret } }),
    JSON.stringify({ error: { code: "http_error", httpStatus: 200 } }),
  ]) {
    const reader = createCloudPageReader(config, async () => ({ ...success, code: 1, stderr }));
    await assert.rejects(
      reader(query),
      (error) =>
        /helper failed/i.test(error.message) &&
        !error.message.includes(secret) &&
        !/HTTP/.test(error.message),
    );
  }
  let invocation;
  const reader = createCloudPageReader(config, async (argv, options) => {
    invocation = { argv, options };
    return success;
  });
  assert.deepEqual(await reader(query, "opaque-input"), {
    entries: [],
    nextPageToken: "opaque-next",
    projectionTruncated: false,
  });
  assert.deepEqual(invocation.argv.slice(-2), ["--page-token", "opaque-input"]);
  assert.equal(invocation.options.timeoutMs, 30000);
  assert.equal(invocation.options.baseEnv.CLOUDSDK_CORE_LOG_HTTP, "false");
});

test("HTTP failure cannot commit a successful page or advance a continuation", async () => {
  let finished = 0,
    failed = 0;
  const ledger = {
    async reserveQuery() {
      return { kind: "reserved", receipt: { id: "fixture" } };
    },
    async finishQuery() {
      finished++;
    },
    async failQuery() {
      failed++;
    },
  };
  const context = {
    agentId: "oncall",
    agentAccountId: "default",
    sessionKey: "thread-one",
    sessionId: "generation-one",
    messageChannel: "slack",
    nativeChannelId: "C123",
    requesterSenderId: "U123",
    assertInvocationCurrent() {},
  };
  const tool = createPagedLogsTool(config, context, async () => httpFailure(400), { ledger });
  await assert.rejects(tool.execute("fixture-call", query), /HTTP 400/);
  assert.equal(finished, 0);
  assert.equal(failed, 1);
});
