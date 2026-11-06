import assert from "node:assert/strict";
import test from "node:test";
import { buildCommandAttemptToolContext } from "../../../src/agents/command/attempt-tool-context.ts";
import { createLogsTool } from "./core.mjs";
import { createRepositoryTool } from "./repository.mjs";

const config = {
  gcloudPath: "/synthetic/not-executed/gcloud",
  cloudSdkConfig: "/synthetic/not-executed/config",
  gcloudAccount: "reader@example.invalid",
  project: "synthetic-project",
  allowedChannelId: "C0123456789",
  allowedSenderId: "U0123456789",
  repositories: [],
};
const origin = Object.freeze({
  sessionKey: "agent:oncall:slack:channel:C0123456789",
  messageProvider: "slack",
  accountId: "origin-account",
  chatType: "channel",
  conversationId: "C0123456789",
  senderId: "U0123456789",
  messageThreadId: "1792710014.413639001",
});
const authorizedReceiver = {
  accountId: "receiver-account",
  chatId: "C0123456789",
  currentChannelId: "C0123456789",
  senderId: "U0123456789",
};

// Inputs here represent host-admitted command options, not an authenticated RPC.
// Native caller admission is exercised in the native subagent integration test.
function consumers({
  requesterOrigin,
  runContext = {},
  message = "synthetic investigation",
  guard = () => {},
} = {}) {
  const facts = buildCommandAttemptToolContext({
    messageChannel: "slack",
    opts: { message, requesterOrigin },
    runContext,
    spawnedBy: "agent:oncall:slack:channel:C0123456789",
  });
  const context = {
    messageChannel: facts.messageChannel,
    nativeChannelId: facts.chatId,
    requesterSenderId: facts.senderId,
    assertInvocationCurrent: guard,
  };
  let commands = 0;
  const runCommand = async () => {
    commands++;
    throw new Error("Unexpected external command");
  };
  return {
    facts,
    logs: createLogsTool(config, context, runCommand),
    repository: createRepositoryTool(config, context, runCommand),
    commandCount: () => commands,
  };
}

void test("admitted requester origin enables both real evidence constructors for an ordinary child", () => {
  const tools = consumers({ requesterOrigin: origin });
  assert.equal(tools.logs?.name, "livex_gcp_logs_read");
  assert.equal(tools.repository?.name, "livex_repository_read");
  assert.equal(tools.facts.currentThreadTs, "1792710014.413639001");
  assert.equal(tools.commandCount(), 0);
});

void test("an unauthorized origin cannot borrow an authorized receiver caller", () => {
  const tools = consumers({
    requesterOrigin: { ...origin, senderId: "UOTHER" },
    runContext: authorizedReceiver,
  });
  assert.equal(tools.logs, null);
  assert.equal(tools.repository, null);
  assert.equal(tools.commandCount(), 0);
});

for (const missing of ["senderId", "conversationId"]) {
  void test(`origin missing ${missing} cannot borrow the receiver's evidence access`, () => {
    const partial = { ...origin };
    delete partial[missing];
    const tools = consumers({ requesterOrigin: partial, runContext: authorizedReceiver });
    assert.equal(tools.logs, null);
    assert.equal(tools.repository, null);
    assert.equal(tools.commandCount(), 0);
  });
}

void test("a foreign-provider origin cannot borrow a Slack receiver route", () => {
  const tools = consumers({
    requesterOrigin: { ...origin, messageProvider: "discord" },
    runContext: authorizedReceiver,
  });
  assert.equal(tools.logs, null);
  assert.equal(tools.repository, null);
  assert.equal(tools.commandCount(), 0);
});

void test("direct authorized calls retain both constructors without a delegated origin", () => {
  const tools = consumers({ runContext: authorizedReceiver });
  assert.equal(tools.logs?.name, "livex_gcp_logs_read");
  assert.equal(tools.repository?.name, "livex_repository_read");
  assert.equal(tools.commandCount(), 0);
});

void test("task text cannot supply missing native caller facts", () => {
  const tools = consumers({
    message: JSON.stringify({
      requesterOrigin: origin,
      senderId: "U0123456789",
      chatId: "C0123456789",
    }),
  });
  assert.equal(tools.logs, null);
  assert.equal(tools.repository, null);
  assert.equal(tools.commandCount(), 0);
});

void test("delegated evidence tools recheck current invocation before any command", async () => {
  let current = true;
  const tools = consumers({
    requesterOrigin: origin,
    guard() {
      if (!current) {
        throw new Error("Retired synthetic invocation");
      }
    },
  });
  assert.ok(tools.logs);
  assert.ok(tools.repository);
  current = false;
  await assert.rejects(
    tools.logs.execute("stale-logs", {
      mode: "discover",
      start: "2026-01-01T10:00:00.000000001Z",
      end: "2026-01-01T10:05:00.000000001Z",
      insertId: "synthetic-event",
    }),
    /Retired synthetic invocation/,
  );
  await assert.rejects(
    tools.repository.execute("stale-repository", { action: "list" }),
    /Retired synthetic invocation/,
  );
  assert.equal(tools.commandCount(), 0);
});
