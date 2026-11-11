import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Isolated boundary regression: the production artifact capture, operation-module
// resolver, plugin entry/factories and SQLite worker execute unchanged. Only the
// API registration collector and synthetic caller/config are test fixtures.
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../../..");
const source = (name: string) => pathToFileURL(path.join(repo, "src", name)).href;
const { createOpenClawTestState } = await import(source("test-utils/openclaw-test-state.ts"));
const { createPluginStateKeyedStoreV2 } = await import(
  source("plugin-state/plugin-state-store.ts")
);
const { closeOpenClawStateDatabaseAsync } = await import(
  source("state/openclaw-state-db-cache.ts")
);
const { PluginInstance } = await import(source("plugins/plugin-instance.ts"));
const { createPluginCache, retirePluginCache, withPluginCache } = await import(
  source("plugins/plugin-cache.ts")
);
const { bindPluginInstanceModuleLoader } = await import(
  source("plugins/plugin-instance-module-loader.ts")
);
const { capturePluginStateOperationModuleSource } = await import(
  source("plugins/plugin-state-operation-source.ts")
);
const started = performance.now();
const state = await createOpenClawTestState({
  label: "livex-loader-regression",
  layout: "state-only",
});
const cache = createPluginCache();
const instance = new PluginInstance("livex-gcp-readonly", { cache });
const config = {
  gcloudPath: "/nonexistent/gcloud",
  cloudSdkConfig: "/nonexistent/cloud",
  gcloudAccount: "reader@example.test",
  project: "example-prd",
  allowedSenderId: "U123",
  allowedChannelId: "*",
  paging: { enabled: true, pythonPath: "/nonexistent/python", sdkRoot: "/nonexistent/sdk" },
};
let current = true;
const assertCurrent = () => {
  if (!current) {
    throw new Error("Synthetic caller revoked");
  }
};
const context = {
  agentId: "oncall",
  agentAccountId: "default",
  sessionKey: "agent:oncall:slack:channel:c123:thread:1792710014.413639",
  sessionId: "generation-one",
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent: assertCurrent,
};
type Tool = {
  name: string;
  execute: (callId: string, args: Record<string, unknown>) => Promise<unknown>;
};
type Factory = { create: (input: typeof context) => Tool | null };
const factories = new Map<string, Factory>();
const stores: Array<{ count: () => Promise<number> }> = [];
const commands = new Map<
  string,
  {
    requiredScopes: string[];
    handler: (ctx: Record<string, unknown>) => Promise<{ text: string }>;
  }
>();
try {
  withPluginCache(cache, () =>
    bindPluginInstanceModuleLoader({
      instance,
      rootDir: root,
      source: path.join(root, "index.ts"),
      origin: "config",
      devSourceRoot: repo,
      pluginSdkResolution: "source",
    }),
  );
  const module = instance.loadModule(path.join(root, "index.ts")) as {
    default: { register: (api: unknown) => void };
  };
  module.default.register({
    pluginConfig: config,
    registerCommand(command: {
      name: string;
      requiredScopes: string[];
      handler: (ctx: Record<string, unknown>) => Promise<{ text: string }>;
    }) {
      commands.set(command.name, command);
    },
    registerTool(factory: Factory, options: { name: string }) {
      assert.equal(typeof factory.create, "function");
      factories.set(options.name, factory);
    },
    runtime: {
      state: {
        openKeyedStoreV2(options: object, authority: { assertCurrent: () => void }) {
          const operationSource = capturePluginStateOperationModuleSource(
            instance,
            authority.assertCurrent,
          );
          assert.ok(operationSource, "Must use the host-captured production operation resolver");
          const store = createPluginStateKeyedStoreV2(
            "livex-gcp-readonly",
            { ...options, env: state.env },
            authority,
            operationSource,
          );
          stores.push(store);
          return store;
        },
      },
    },
  });
  const factory = factories.get("livex_gcp_logs_read");
  assert.ok(factory, "The plugin must register its log tool");
  const tool = factory.create(context);
  assert.ok(tool, "An authorized caller must receive the log tool");
  assert.equal(tool.name, "livex_gcp_logs_read");
  // A cursor miss uses the real worker-loaded handler without a cloud process.
  // Nonexistent cloud binaries make an accidental cloud-read attempt fail.
  await assert.rejects(
    tool.execute("cursor-probe", { cursor: "a".repeat(64) }),
    /Unknown, evicted, or cross-session cursor/,
  );
  assert.equal(stores.length, 1);
  assert.equal(await stores[0].count(), 0);
  assert.equal(factory.create({ ...context, requesterSenderId: "U999" }), null);
  assert.equal(factory.create({ ...context, messageChannel: "discord" }), null);
  const recovery = commands.get("livex-gcp-recover");
  assert.ok(recovery, "The production plugin must register recovery");
  assert.deepEqual(recovery.requiredScopes, ["operator.admin"]);
  const commandContext = {
    channel: "slack",
    senderId: "U123",
    isAuthorizedSender: true,
    senderIsOwner: true,
    assertOwnerCurrent: assertCurrent,
    agentId: context.agentId,
    accountId: context.agentAccountId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    from: "slack:channel:C123",
    to: "channel:C123",
    messageThreadId: "1792710014.413639",
  };
  const listing = JSON.parse((await recovery.handler({ ...commandContext, args: "list" })).text);
  assert.deepEqual(listing.receipts, []);
  await assert.rejects(
    recovery.handler({ ...commandContext, senderIsOwner: false, args: "list" }),
    /owner/,
  );
  await assert.rejects(
    recovery.handler({ ...commandContext, messageThreadId: "1792710014.413640", args: "list" }),
    /thread/,
  );
  const { createPageLedger } = await import(pathToFileURL(path.join(root, "page-store.mjs")).href);
  const ledger = createPageLedger(stores[0], context, config);
  const receiptId = "c".repeat(64),
    query = {
      mode: "discover",
      insertIds: ["synthetic-seed"],
      start: "2026-10-20T16:00:00.000Z",
      end: "2026-10-20T17:00:00.000Z",
      limit: 1,
    };
  await ledger.reserveQuery({ toolCallId: "native-original", fingerprint: receiptId, query });
  const inspection = JSON.parse(
    (await recovery.handler({ ...commandContext, args: `inspect ${receiptId}` })).text,
  );
  await assert.rejects(
    recovery.handler({ ...commandContext, args: `retry ${receiptId} ${"d".repeat(64)}` }),
    /changed/,
  );
  await recovery.handler({
    ...commandContext,
    args: `retry ${receiptId} ${inspection.receiptHash}`,
  });
  const resumed = await ledger.reserveQuery({
    toolCallId: "native-retry",
    fingerprint: receiptId,
    query,
  });
  assert.equal(resumed.kind, "reserved");
  assert.equal(resumed.receipt.attempt, 1);
  await ledger.finishQuery({
    toolCallId: "native-retry",
    receiptId,
    result: { entries: [], nextCursor: null, windowExhausted: true },
  });
  assert.equal(
    (await ledger.reserveQuery({ toolCallId: "native-replay", fingerprint: receiptId, query }))
      .kind,
    "cached",
  );
  assert.equal(await stores[0].count(), 1);
  current = false;
  await assert.rejects(recovery.handler({ ...commandContext, args: "list" }), /revoked/);
  await assert.rejects(
    tool.execute("revoked-probe", { cursor: "b".repeat(64) }),
    /Synthetic caller revoked/,
  );
  console.log(
    JSON.stringify({
      realModuleResolver: true,
      logsToolCreated: true,
      nativeWorkerCursorLookup: true,
      nativeWorkerOperatorRecovery: true,
      registeredOwnerScope: true,
      unauthorizedCallerRejected: true,
      revokedCallerRejected: true,
      cloudReads: 0,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  await instance.dispose();
  await retirePluginCache(cache);
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
}
