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
  sessionKey: "thread-one",
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
  current = false;
  await assert.rejects(
    tool.execute("revoked-probe", { cursor: "b".repeat(64) }),
    /Synthetic caller revoked/,
  );
  console.log(
    JSON.stringify({
      realModuleResolver: true,
      logsToolCreated: true,
      nativeWorkerCursorLookup: true,
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
