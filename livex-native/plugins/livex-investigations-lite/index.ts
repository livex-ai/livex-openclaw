import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createHooks,
  createLog,
  createLookupTool,
  createMemory,
  createRecordTool,
  storeOptions,
  validateConfig,
} from "./core.mjs";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    // The keyed store V2 API is required; without it the plugin stays inert.
    if (typeof api.runtime.state.openKeyedStoreV2 !== "function") {
      return;
    }
    const config = validateConfig(api.pluginConfig);
    const options = storeOptions(config);
    const openStore = (authority?: { assertCurrent: () => void }) =>
      api.runtime.state.openKeyedStoreV2(options, authority);
    // The store is opened lazily (hooks and tools), never here: during register()
    // the plugin record is not yet active, so openKeyedStoreV2 would throw
    // (src/plugins/registry-runtime.ts:114-124). Failures are logged, not hidden.
    const log = createLog(api.logger);
    const memory = createMemory(config, { openStore, log });
    const hooks = createHooks(config, memory, openStore, log);

    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => createRecordTool(config, context, memory),
      },
      { name: "investigation_record", optional: true, workspaceAccess: false },
    );
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) =>
          createLookupTool(
            config,
            context,
            (authority?: { assertCurrent: () => void }) => openStore(authority),
            log,
          ),
      },
      { name: "investigation_lookup", optional: true, workspaceAccess: false },
    );

    api.on("before_prompt_build", (event, ctx) => hooks.beforePromptBuild(event, ctx));
    // Priority 100 runs before the summary-card hook (default 0), which rewrites
    // the payload: this hook must see the raw envelope. It never modifies it.
    api.on("reply_payload_sending", (event, ctx) => hooks.replyPayloadSending(event, ctx), {
      priority: 100,
    });
    api.on("message_sent", (event, ctx) => hooks.messageSent(event, ctx));
  },
});
