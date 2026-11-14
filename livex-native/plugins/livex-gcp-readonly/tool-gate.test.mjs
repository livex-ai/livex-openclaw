import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogsTool } from "./core.mjs";
import { createMetricsTool } from "./metrics.mjs";
import { createRepositoryTool } from "./repository.mjs";
import { logNotOffered, toolGateRefusal } from "./tool-gate.mjs";

const config = {
  gcloudPath: "/opt/google-cloud-sdk/bin/gcloud",
  cloudSdkConfig: "/home/pilot/.config/gcloud",
  gcloudAccount: "investigator@example.test",
  project: "example-prd",
  allowedChannelId: "C123",
  allowedSenderId: "U123",
};
const good = {
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent() {},
};
const makers = {
  livex_gcp_logs_read: (context, options) => createLogsTool(config, context, async () => ({}), options),
  livex_gcp_metrics_read: (context, options) => createMetricsTool(config, context, async () => ({}), options),
  livex_repository_read: (context, options) =>
    createRepositoryTool({ ...config, repositories: [] }, context, async () => ({}), options),
};

test("toolGateRefusal names a fixed reason for each gate", () => {
  assert.equal(toolGateRefusal(config, good), null);
  assert.equal(toolGateRefusal(config, { ...good, messageChannel: "web" }), "not a Slack context");
  assert.equal(toolGateRefusal(config, { ...good, nativeChannelId: "x" }), "no Slack channel id");
  assert.equal(toolGateRefusal(config, { ...good, nativeChannelId: "C999" }), "channel not allowed");
  assert.equal(toolGateRefusal(config, { ...good, requesterSenderId: "U999" }), "requester not allowed");
  assert.equal(toolGateRefusal(config, { ...good, assertInvocationCurrent: undefined }), "no invocation guard");
  assert.equal(toolGateRefusal({ ...config, allowedChannelId: "*" }, { ...good, nativeChannelId: "C999" }), null);
});

test("each tool factory logs why it is not offered, once per reason per minute, with no payload", () => {
  for (const [tool, make] of Object.entries(makers)) {
    const lines = [];
    let time = 5_000_000_000_000;
    const options = { warn: (line) => lines.push(line), now: () => time };
    const secret = { requesterSenderId: "U0SECRETSENDER", nativeChannelId: "C123" };
    assert.equal(make({ ...good, ...secret }, options), null);
    assert.equal(make({ ...good, ...secret }, options), null);
    assert.deepEqual(lines, [`livex-gcp-readonly: tool not offered: requester not allowed (${tool})`]);
    assert.ok(!/SECRET/u.test(lines[0]));
    // Another reason logs immediately; the same reason again only after a minute.
    assert.equal(make({ ...good, messageChannel: "web" }, options), null);
    assert.equal(lines.length, 2);
    time += 60_001;
    assert.equal(make({ ...good, ...secret }, options), null);
    assert.equal(lines.length, 3);
    // An authorized caller is offered the tool and logs nothing.
    assert.ok(make(good, options));
    assert.equal(lines.length, 3);
  }
});

test("logNotOffered never throws when logging fails", () => {
  assert.doesNotThrow(() =>
    logNotOffered("t", "r", {
      warn() {
        throw new Error("boom");
      },
    }),
  );
});
