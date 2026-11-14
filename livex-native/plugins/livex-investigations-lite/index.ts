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
      console.warn("[livex-investigations-lite] inert: api.runtime.state.openKeyedStoreV2 is unavailable");
      return;
    }
    const config = validateConfig(api.pluginConfig);
    const options = storeOptions(config);
    const openStore = (authority?: { assertCurrent: () => void }) =>
      api.runtime.state.openKeyedStoreV2(options, authority);
    // The store is opened lazily (hooks and tools), never here: during register()
    // the plugin record is not yet active, so openKeyedStoreV2 would throw
    // (src/plugins/registry-runtime.ts:114-124). Failures are logged, not hidden.
    // Written to the process console (container stdout) with the plugin prefix, like
    // the gateway's other lines: the host's subsystem logger can filter by level.
    const log = createLog();
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

    // Diagnostic trace (DEV): one warn line per hook call with routing facts only
    // (hook, kind, channel, session key shape, whether ids are present), never content.
    const trace = (hook: string, event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey ?? ctx?.sessionKey;
        const shape = typeof sessionKey === "string" ? sessionKey.split(":").slice(0, 4).join(":") : "none";
        console.warn(
          `[livex-investigations-lite] trace ${hook} kind=${event?.kind ?? "-"} channel=${event?.channel ?? ctx?.channelId ?? "-"} ` +
            `session=${shape} runId=${event?.runId || ctx?.runId ? "yes" : "no"} sender=${ctx?.senderId ? "yes" : "no"} ` +
            `success=${event?.success ?? "-"} hasText=${typeof event?.payload?.text === "string" && event.payload.text.length > 0}`,
        );
      } catch {
        // Tracing must never affect a reply.
      }
    };

    api.on("before_prompt_build", (event, ctx) => {
      trace("before_prompt_build", event, ctx);
      return hooks.beforePromptBuild(event, ctx);
    });
    // Priority 100 runs before the summary-card hook (default 0), which rewrites
    // the payload: this hook must see the raw envelope. It never modifies it.
    api.on(
      "reply_payload_sending",
      (event, ctx) => {
        trace("reply_payload_sending", event, ctx);
        return hooks.replyPayloadSending(event, ctx);
      },
      { priority: 100 },
    );
    api.on("message_sent", (event, ctx) => {
      trace("message_sent", event, ctx);
      return hooks.messageSent(event, ctx);
    });
    console.warn(
      `[livex-investigations-lite] registered: tools=investigation_record,investigation_lookup hooks=before_prompt_build,reply_payload_sending,message_sent agents=${config.agents.join(",")}`,
    );
  },
});
