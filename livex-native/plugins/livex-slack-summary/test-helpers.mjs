// Loads the real entry with a stubbed plugin SDK and a fake host API. No Slack,
// network or gateway state.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-only: capture each createPlugin() instance so tests can read its internals.
const plugins = [];
globalThis.__livexSlackSummaryPlugins = plugins;
const sdkHook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/core.mjs?capture") || result.source == null) {
      return result;
    }
    const source = String(result.source).replace(
      "export function createPlugin(",
      "function createPluginInner(",
    ) + `
export function createPlugin(...args) {
  const plugin = createPluginInner(...args);
  globalThis.__livexSlackSummaryPlugins.push(plugin);
  return plugin;
}
`;
    return { ...result, source };
  },
  resolve(specifier, context, nextResolve) {
    if (specifier === "./core.mjs" && context.parentURL?.endsWith("/index.ts")) {
      // A separate instance of core.mjs for the entry, so its createPlugin() can be captured.
      const resolved = nextResolve(specifier, context);
      return { ...resolved, url: `${resolved.url}?capture` };
    }
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
export const MARK = "LIVEX_ALERT_SUMMARY_V2";

export const summary = {
  title: "checkout-api upstream timeouts",
  signature: "checkout-api | create order | upstream timeout",
  priority: "medium",
  provisional: true,
  summary: "An upstream timeout was recovered by the request retry.",
  nextAction: "Confirm whether later requests needed retries.",
  owner: "Unassigned",
  checkedWindow: "2026-01-21 12:20–12:25 UTC",
  evidenceUrl: "https://console.cloud.google.com/logs/query?project=livex-copilot-prd&query=insertId%3D%22abc123%22",
};
export const envelope = (fields = summary, full = "Full report with private IDs.") =>
  `${MARK}\n${JSON.stringify(fields)}\n\n${full}`;

export const baseConfig = { allowedChannelId: CHANNEL, allowedSenderId: SENDER };

export const newStateDir = () => mkdtempSync(join(tmpdir(), "livex-slack-summary-"));

/**
 * Register the entry against a state dir (a fresh temp dir unless one is given, so two
 * calls with the same dir behave like two plugin instances in one gateway).
 * Returns the hooks, the interactive registration, the logged warnings and the state dir.
 */
export function load(pluginConfig = baseConfig, { stateDir = newStateDir(), runtime, logger = true } = {}) {
  const hooks = new Map();
  const registrations = [];
  const warnings = [];
  const before = plugins.length;
  entry.register({
    pluginConfig,
    runtime: runtime ?? { state: { resolveStateDir: () => stateDir } },
    ...(logger ? { logger: { warn: (message) => void warnings.push(String(message)) } } : {}),
    on(name, handler) {
      assert.equal(hooks.has(name), false, `${name} registered twice`);
      hooks.set(name, handler);
    },
    registerInteractiveHandler(registration) {
      registrations.push(registration);
    },
  });
  return { hooks, registrations, interactive: registrations[0], entry, warnings, stateDir, plugin: plugins[before] };
}

/**
 * Send the final reply through the render hook and confirm it like Slack would.
 * `evidence` URLs are first recorded as if the log tool returned them in this session.
 */
export function postCard(loaded, { sessionKey = SESSION, ts = CARD_TS, fields = summary, content = "", runId, evidence = [] } = {}) {
  if (evidence.length) {
    recordEvidence(loaded, { entryUrls: evidence, sessionKey });
  }
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
  // Anything on `replies` (reply or followUp) would post to Slack's response_url and replace the card.
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

/** The card's slack channelData in the legacy flat order: Title, attachment blocks, then the rest (buttons). */
export const flat = (slack) => [slack.blocks[0], ...(slack.attachments?.[0]?.blocks ?? []), ...slack.blocks.slice(1)];

export const PROJECT = "livex-copilot-prd";

/**
 * Feed a livex_gcp_logs_read result to the after_tool_call hook like the host does:
 * `{ content: [text], details }` with the links the gcp plugin would produce.
 */
export function recordEvidence(
  loaded,
  { logsExplorerUrl, entryUrls = [], project = PROJECT, sessionKey = SESSION, toolName = "livex_gcp_logs_read", textOnly = false, error } = {},
) {
  const details = {
    project,
    ...(logsExplorerUrl ? { logsExplorerUrl } : {}),
    entries: entryUrls.map((entryUrl, index) => ({ insertId: `id${index}`, timestamp: "2026-01-21T12:20:00Z", entryUrl })),
  };
  const result = textOnly
    ? { content: [{ type: "text", text: JSON.stringify(details) }] }
    : { content: [{ type: "text", text: JSON.stringify(details) }], details };
  return loaded.hooks.get("after_tool_call")(
    { toolName, params: {}, result, ...(error ? { error } : {}) },
    { toolName, sessionKey, agentId: "debugger" },
  );
}

/** The plugin's recorded logs-read outcome for a thread session. */
export const readStats = (loaded, sessionKey) => loaded.plugin.readStatsFor(sessionKey);
