import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { INTERACTIVE_NAMESPACE, createPlugin, loadSigningKey, readConfig } from "./core.mjs";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function resolveStateDir(api: any): string | undefined {
  try {
    const resolved = api.runtime?.state?.resolveStateDir?.();
    if (typeof resolved === "string" && resolved.trim()) {
      return resolved;
    }
  } catch {
    // Fall through to the environment.
  }
  const fromEnv = process.env.OPENCLAW_STATE_DIR;
  return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv : undefined;
}

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    const warn = (message: string) => {
      if (typeof api.logger?.warn === "function") {
        api.logger.warn(message);
      } else {
        console.warn(message);
      }
    };

    // Button tokens are signed with a key kept in a file under the state dir, read
    // synchronously here so every plugin instance and every restart shares it. Without
    // a usable key, buttons stay off: no controls on the card and no click handler.
    let key: Buffer | undefined;
    if (readConfig(api.pluginConfig).buttons) {
      const loaded = loadSigningKey(resolveStateDir(api));
      if ("key" in loaded) {
        key = loaded.key;
      } else {
        warn(`livex-slack-summary: priority buttons disabled: ${loaded.error}`);
      }
    }
    const plugin = createPlugin(api.pluginConfig, { key, warn });

    // Renders the marked summary as a card and remembers it until Slack confirms the post.
    api.on("reply_payload_sending", (event, ctx) => plugin.replyPayloadSending(event, ctx));
    // Learns the Slack ts of each confirmed card (the amendment allow-list).
    api.on("message_sent", (event, ctx) => plugin.messageSent(event, ctx));
    // Records the evidence links the log tool returned; a card may cite only those.
    api.on("after_tool_call", (event, ctx) => plugin.afterToolCall(event, ctx));
    // Lets the debugger's message `edit` touch only its own card in this thread.
    api.on("before_tool_call", (event, ctx) => plugin.beforeToolCall(event, ctx));

    // Priority buttons need the sender and channel gates and a signing key.
    if (plugin.config.buttons && typeof api.registerInteractiveHandler === "function") {
      api.registerInteractiveHandler({
        channel: "slack",
        namespace: INTERACTIVE_NAMESPACE,
        handler: (ctx) => plugin.interactive(ctx),
      });
    }
  },
});
