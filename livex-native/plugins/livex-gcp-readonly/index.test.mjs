import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transactionMemoryStore } from "./page-lru-test-helpers.mjs";

test("the plugin entry uses bounded log reads when the host lacks V2 state", async () => {
  // The standalone suite has no host SDK installed. Stub only its entry and
  // process adapters, and run the real registered factories and tool handlers.
  const sdkModules = new Map([
    [
      "openclaw/plugin-sdk/plugin-entry",
      "export const definePluginEntry = (entry) => entry; " +
        "export const buildJsonPluginConfigSchema = (schema) => schema;",
    ],
    [
      "openclaw/plugin-sdk/process-runtime",
      'export const runUtf8CommandWithTimeout = async () => ({ code: 0, termination: "exit", stdout: "[]" });',
    ],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = sdkModules.get(specifier);
      return source === undefined
        ? nextResolve(specifier, context)
        : { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    },
  });
  const { default: entry } = await import("./index.ts").finally(() => hooks.deregister());
  const pluginConfig = {
    gcloudPath: "/sdk/bin/gcloud",
    cloudSdkConfig: "/private/cloud",
    gcloudAccount: "reader@example.test",
    project: "example-prd",
    allowedSenderId: "U123",
    allowedChannelId: "*",
    paging: { enabled: true, pythonPath: "/usr/bin/python3", sdkRoot: "/sdk" },
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
  const register = (state) => {
    const factories = new Map();
    const commands = new Set();
    entry.register({
      pluginConfig,
      runtime: { state, agent: { session: {} } },
      registerCommand: (command) => commands.add(command.name),
      registerTool: (factory, { name }) => factories.set(name, factory),
    });
    return { logs: factories.get("livex_gcp_logs_read"), commands };
  };

  const olderHost = register({
    openKeyedStore() {
      assert.fail("The older state API cannot back durable paging");
    },
  });
  assert.equal(olderHost.logs.create({ ...context, requesterSenderId: "U999" }), null);
  const unpaged = olderHost.logs.create(context);
  assert.deepEqual(unpaged.parameters.required, ["start", "end"]);
  assert.equal(olderHost.commands.has("livex-gcp-recover"), false);
  const result = await unpaged.execute("bounded-read", {
    mode: "discover",
    insertId: "synthetic-entry",
    start: "2026-10-20T16:00:00Z",
    end: "2026-10-20T17:00:00Z",
  });
  assert.deepEqual(result.details.entries, []);

  const currentHost = register({
    openKeyedStoreV2: () => transactionMemoryStore(),
  });
  const paged = currentHost.logs.create(context);
  assert.equal(currentHost.commands.has("livex-gcp-recover"), true);
  await assert.rejects(
    paged.execute("cursor-probe", { cursor: "a".repeat(64) }),
    /Unknown, evicted, or cross-session cursor/,
  );
});
