import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createLogsTool } from "./core.mjs";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createPageLedger, PAGE_CACHE_ENTRIES } from "./page-store.mjs";
import { createPagedLogsTool } from "./paging.mjs";
import { createRepositoryTool } from "./repository.mjs";

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => {
          const config = api.pluginConfig;
          const legacy = createLogsTool(config, context, runUtf8CommandWithTimeout);
          const paging = config?.paging;
          if (
            !legacy ||
            typeof paging !== "object" ||
            paging === null ||
            !("enabled" in paging) ||
            paging.enabled !== true
          ) {
            return legacy;
          }
          // Open state only for an authorized invocation. The host retains this
          // assertion through the final storage effect; never share its handle.
          const store = api.runtime.state.openKeyedStoreV2(
            {
              namespace: "log-pages",
              maxEntries: PAGE_CACHE_ENTRIES,
              overflowPolicy: "reject-new",
            },
            { assertCurrent: context.assertInvocationCurrent },
          );
          const ledger = createPageLedger(store, context, config);
          return createPagedLogsTool(config, context, runUtf8CommandWithTimeout, { ledger });
        },
      },
      { name: "livex_gcp_logs_read", optional: true, workspaceAccess: false },
    );
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) =>
          createRepositoryTool(
            { ...api.pluginConfig, repositories: api.pluginConfig?.repositories ?? [] },
            context,
            runUtf8CommandWithTimeout,
          ),
      },
      { name: "livex_repository_read", optional: true, workspaceAccess: false },
    );
  },
});
