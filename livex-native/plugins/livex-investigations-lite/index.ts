import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createHooks,
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
    const memory = createMemory(config, { openStore });
    const hooks = createHooks(config, memory, openStore);

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
          createLookupTool(config, context, (authority?: { assertCurrent: () => void }) =>
            openStore(authority),
          ),
      },
      { name: "investigation_lookup", optional: true, workspaceAccess: false },
    );

    api.on("before_prompt_build", (event, ctx) => hooks.beforePromptBuild(event, ctx));
    api.on("reply_payload_sending", (event, ctx) => hooks.replyPayloadSending(event, ctx));
    api.on("message_sent", (event, ctx) => hooks.messageSent(event, ctx));
  },
});
