// Loads the real entry with a stubbed plugin SDK and a fake host API. No Slack,
// network or gateway state.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const sdkHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "openclaw/plugin-sdk/plugin-entry") {
      return nextResolve(specifier, context);
    }
    const source =
      "export const definePluginEntry = (entry) => entry; export const buildJsonPluginConfigSchema = (schema) => schema;";
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  },
});
const { default: entry } = await import("./index.ts").finally(() => sdkHook.deregister());

export const CHANNEL = "C0ALERTS1";
export const SENDER = "U0ALLOWED";
export const THREAD = "1768996800.000001";
export const SESSION = `agent:debugger:slack:channel:${CHANNEL.toLowerCase()}:thread:${THREAD}`;
export const CARD_TS = "1768996900.000100";
export const MARK = "LIVEX_ALERT_SUMMARY_V1";

export const summary = {
  priority: "medium",
  provisional: true,
  impact: "An upstream timeout was recovered by the request retry.",
  nextAction: "Confirm whether later requests needed retries.",
  owner: "Unassigned",
  checkedWindow: "2026-01-21 12:20–12:25 UTC",
  evidenceUrl: "https://console.cloud.google.com/logs/query?window=short&level=error",
};
export const envelope = (fields = summary, full = "Full report with private IDs.") =>
  `${MARK}\n${JSON.stringify(fields)}\n\n${full}`;

export const baseConfig = { allowedChannelId: CHANNEL, allowedSenderId: SENDER };

/** Register the entry; returns the hooks, the interactive registration and a call log. */
export function load(pluginConfig = baseConfig, store) {
  const hooks = new Map();
  const registrations = [];
  entry.register({
    pluginConfig,
    runtime: { state: store ? { openKeyedStoreV2: (options) => ((store.opened = options), store) } : {} },
    on(name, handler) {
      assert.equal(hooks.has(name), false, `${name} registered twice`);
      hooks.set(name, handler);
    },
    registerInteractiveHandler(registration) {
      registrations.push(registration);
    },
  });
  return { hooks, registrations, interactive: registrations[0], entry };
}

/** In-memory fake of the keyed store surface the plugin uses (lookup/register). */
export function fakeStore({ failing = false, hang = false } = {}) {
  const rows = new Map();
  return {
    rows,
    async lookup(key) {
      if (hang) return new Promise(() => {});
      if (failing) throw new Error("store down");
      await Promise.resolve();
      return rows.get(key);
    },
    async registerIfAbsent(key, value) {
      if (failing) throw new Error("store down");
      if (rows.has(key)) return false;
      rows.set(key, structuredClone(value));
      return true;
    },
    async register(key, value) {
      if (failing) throw new Error("store down");
      rows.set(key, structuredClone(value));
    },
  };
}

/** Register against a store and wait for the key to load, as the gateway's first seconds do. */
export async function loadWithStore(store, pluginConfig = baseConfig) {
  const loaded = load(pluginConfig, store);
  await new Promise((resolve) => setImmediate(resolve));
  return loaded;
}

/** Send the final reply through the render hook and confirm it like Slack would. */
export function postCard(loaded, { sessionKey = SESSION, ts = CARD_TS, fields = summary, content = "", runId } = {}) {
  const result = loaded.hooks.get("reply_payload_sending")(
    { kind: "final", channel: "slack", sessionKey, runId, payload: { text: envelope(fields) } },
    { channelId: "slack", sessionKey },
  );
  loaded.hooks.get("message_sent")(
    { to: `channel:${CHANNEL}`, content, success: true, messageId: ts, sessionKey, runId },
    { channelId: "slack", sessionKey },
  );
  return result;
}

export function fakeClick({ value, sender = SENDER, conversationId = CHANNEL, messageTs = CARD_TS, kind = "button", threadTs = THREAD }) {
  const calls = { edits: [], replies: [] };
  const namespace = value.slice(0, value.indexOf(":"));
  const payload = value.slice(namespace.length + 1);
  return {
    calls,
    ctx: {
      channel: "slack",
      accountId: "default",
      interactionId: "i1",
      conversationId,
      senderId: sender,
      auth: { isAuthorizedSender: true },
      interaction: { kind, data: value, namespace, payload, actionId: "openclaw:callback_button:1:1", messageTs, threadTs, value },
      respond: {
        acknowledge: async () => {},
        reply: async (params) => void calls.replies.push(params),
        followUp: async (params) => void calls.replies.push(params),
        editMessage: async (params) => void calls.edits.push(params),
      },
    },
  };
}

export const buttonsOf = (blocks) =>
  blocks.find((block) => block.type === "actions")?.elements ?? [];
export const labelsOf = (blocks) => buttonsOf(blocks).map((button) => button.text.text);
