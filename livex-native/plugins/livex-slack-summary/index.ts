import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { INTERACTIVE_NAMESPACE, KEY_STORE_OPTIONS, createPlugin, loadOrCreateKey } from "./core.mjs";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const KEY_WAIT_MS = 2000;

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    const plugin = createPlugin(api.pluginConfig);

    // Button tokens are signed. The key is persisted so old cards keep working after a
    // restart; without the keyed store a per-process key is used and clicks on cards
    // posted before a restart fail closed. Other hooks wait for it only briefly while it loads.
    let loading: Promise<void> | null = null;
    try {
      const open = api.runtime?.state?.openKeyedStoreV2;
      if (typeof open === "function") {
        loading = loadOrCreateKey(open(KEY_STORE_OPTIONS))
          .then((key) => (key ? plugin.setKey(key) : undefined))
          .catch(() => undefined)
          .then(() => {
            loading = null;
          });
      }
    } catch {
      loading = null;
    }
    // Other hooks and clicks wait for the key at most KEY_WAIT_MS, then use the current key.
    const gate =
      (fn: (...args: any[]) => unknown) =>
      (...args: any[]) => {
        const wait = loading;
        if (!wait) {
          return fn(...args);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const delay = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, KEY_WAIT_MS);
        });
        return Promise.race([wait, delay]).then(() => {
          clearTimeout(timer);
          return fn(...args);
        });
      };

    // Renders the marked summary as a card and remembers it until Slack confirms the post.
    // Never gated on the key: reply_payload_sending fails open on timeout, which would post
    // the raw envelope. Until the stored key loads the interim per-process key signs the
    // buttons, and a card signed with it fails closed on click once the stored key is in.
    api.on("reply_payload_sending", (event, ctx) => plugin.replyPayloadSending(event, ctx));
    // Learns the Slack ts of each confirmed card (the amendment allow-list).
    api.on("message_sent", gate((event, ctx) => plugin.messageSent(event, ctx)));
    // Lets the debugger's message `edit` touch only its own card in this thread.
    api.on("before_tool_call", gate((event, ctx) => plugin.beforeToolCall(event, ctx)));

    // Priority buttons need the sender and channel gates; without them cards stay button-free.
    if (plugin.config.buttons && typeof api.registerInteractiveHandler === "function") {
      api.registerInteractiveHandler({
        channel: "slack",
        namespace: INTERACTIVE_NAMESPACE,
        handler: gate((ctx) => plugin.interactive(ctx)),
      });
    }
  },
});
