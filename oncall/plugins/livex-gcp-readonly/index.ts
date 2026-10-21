import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createLogsTool } from "./core.mjs";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => createLogsTool(api.pluginConfig, context, runUtf8CommandWithTimeout),
      },
      { name: "livex_gcp_logs_read", optional: true, workspaceAccess: false },
    );
  },
});
