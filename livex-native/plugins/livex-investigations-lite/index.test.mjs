import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { baseConfig, memoryStore, SENDER, SESSION, toolContext } from "./test-helpers.mjs";

const sdk = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "openclaw/plugin-sdk/plugin-entry") return nextResolve(specifier, context);
    const source =
      "export const definePluginEntry = (entry) => entry; export const buildJsonPluginConfigSchema = (schema) => schema;";
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  },
});
const { default: entry } = await import("./index.ts").finally(() => sdk.deregister());

function register(state, extra = {}) {
  const factories = new Map();
  const handlers = new Map();
  const opened = [];
  const hookOpts = new Map();
  entry.register({
    pluginConfig: baseConfig,
    runtime: {
      state: {
        ...state,
        ...(state.store
          ? {
              openKeyedStoreV2(options, authority) {
                opened.push({ options, authority });
                return state.store;
              },
            }
          : {}),
      },
    },
    registerTool: (factory, opts) => factories.set(opts.name, { factory, opts }),
    on: (name, handler, opts) => {
      handlers.set(name, handler);
      hookOpts.set(name, opts);
    },
    ...extra,
  });
  return { factories, handlers, opened, hookOpts };
}

test("the entry stays inert on a host without the V2 keyed store", () => {
  const { factories, handlers } = register({});
  assert.equal(factories.size, 0);
  assert.equal(handlers.size, 0);
});

test("the entry registers gated tools and the three hooks end to end", async () => {
  const store = memoryStore();
  const { factories, handlers, opened } = register({ store });
  assert.deepEqual([...factories.keys()].sort(), ["investigation_lookup", "investigation_record"]);
  assert.deepEqual([...handlers.keys()].sort(), ["before_prompt_build", "message_sent", "reply_payload_sending"]);
  for (const { factory, opts } of factories.values()) {
    assert.equal(factory.contextVersion, 2);
    assert.equal(opts.optional, true);
    assert.equal(factory.create(toolContext({ requesterSenderId: "U0OTHER" })), null);
  }

  const promptCtx = { channelId: "slack", sessionKey: SESSION, agentId: "debugger", senderId: SENDER, runId: "r" };
  await handlers.get("before_prompt_build")({ prompt: "start of turn" }, promptCtx);
  const record = factories.get("investigation_record").factory.create(toolContext());
  await record.execute("c", {
    signature: "checkout-api | create order | upstream timeout",
    priority: "medium",
    resolved: true,
    finding: "Recovered after provider retry.",
  });
  assert.equal(store.rows.size, 0);
  handlers.get("reply_payload_sending")(
    { kind: "final", channel: "slack", sessionKey: SESSION, runId: "r", payload: {} },
    { channelId: "slack", sessionKey: SESSION, senderId: SENDER, runId: "r" },
  );
  await handlers.get("message_sent")(
    { success: true, sessionKey: SESSION, messageId: "1768996900.000200" },
    { channelId: "slack", sessionKey: SESSION },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.rows.size, 1);

  const injected = await handlers.get("before_prompt_build")(
    { prompt: "checkout-api create order upstream timeout" },
    { ...promptCtx, runId: "r" },
  );
  assert.match(injected.prependContext, /latest medium resolved/);
  assert.ok(!injected.prependContext.includes("Recovered after provider retry"));

  const lookup = factories.get("investigation_lookup").factory.create(toolContext());
  const found = await lookup.execute("c", { query: "create order upstream timeout checkout-api" });
  assert.equal(found.details.cases.length, 1);
  assert.match(found.details.cases[0].occurrences[0].finding, /Recovered after provider retry/);
  const withAuthority = opened.filter((o) => o.authority);
  assert.ok(withAuthority.length >= 1, "tool reads bind the invocation authority");
  assert.deepEqual(opened[0].options, { namespace: "cases", maxEntries: 500, overflowPolicy: "evict-oldest" });
});

test("reply_payload_sending runs first (priority 100), the store is never opened during register", () => {
  const store = memoryStore();
  const { hookOpts, opened } = register({ store });
  assert.equal(hookOpts.get("reply_payload_sending").priority, 100);
  assert.equal(hookOpts.get("before_prompt_build")?.priority, undefined);
  assert.equal(opened.length, 0, "openKeyedStoreV2 throws during register(); it must be opened lazily");
});

// The entry logs to the process console (container stdout), not api.logger.
function captureConsole() {
  const lines = [];
  const saved = { info: console.info, warn: console.warn };
  console.info = (m) => lines.push(["info", String(m)]);
  console.warn = (m) => lines.push(["warn", String(m)]);
  return { lines, restore: () => Object.assign(console, saved) };
}

const envelopeText = (over = {}) =>
  `LIVEX_ALERT_SUMMARY_V2\n${JSON.stringify({ title: "T", signature: "checkout-api | create order | upstream timeout", priority: "high", provisional: false, summary: "Provider timed out.", nextAction: "Page owner.", owner: "payments", checkedWindow: "30m", ...over })}\n\nfull`;

test("real Codex + Slack event shapes: auto-record commits and every decision is logged to the console", async () => {
  const cap = captureConsole();
  try {
    const store = memoryStore();
    const { handlers } = register({ store });
    // Codex app-server before_prompt_build ctx (buildAgentHookContext: runId, agentId,
    // sessionKey, channelId, senderId for trigger "user"); its runId is the Codex run's.
    const codexCtx = { runId: "codex-run-1", agentId: "debugger", sessionKey: SESSION, channelId: "slack", senderId: SENDER, trigger: "user" };
    await handlers.get("before_prompt_build")({ prompt: "alert text", currentUserMessage: "alert text", messages: [] }, codexCtx);
    // Slack reply path (deliver-hooks.ts): ctx = toPluginMessageContext (no agentId), runId from
    // the dispatcher run state, which may name the run differently than the harness did.
    const payload = { text: envelopeText() };
    const before = JSON.stringify(payload);
    const out = handlers.get("reply_payload_sending")(
      { payload, kind: "final", channel: "slack", sessionKey: SESSION, runId: "dispatch-run-9" },
      { channelId: "slack", accountId: "default", conversationId: "channel:C0ALERTS1", sessionKey: SESSION, senderId: SENDER, runId: "dispatch-run-9" },
    );
    assert.equal(out, undefined);
    assert.equal(JSON.stringify(payload), before);
    // Slack message_sent (message-hook-mappers.ts): sessionKey on the event, no runId, no senderId.
    await handlers.get("message_sent")(
      { to: "channel:C0ALERTS1", content: "card", success: true, messageId: "1768996900.000200", sessionKey: SESSION },
      { channelId: "slack", accountId: "default", conversationId: "channel:C0ALERTS1", sessionKey: SESSION },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.rows.size, 1);
    const text = cap.lines.map(([, m]) => m).join("\n");
    for (const expected of [/record staged: source=envelope/u, /reply tagged: records=1/u, /case committed sig=[0-9a-f]{8} occurrences=1/u]) {
      assert.match(text, expected);
    }
    assert.ok(cap.lines.every(([, m]) => m.startsWith("[livex-investigations-lite] ")));
    assert.ok(!/checkout|Provider timed out|payments/u.test(text), "no content in any log line");
  } finally {
    cap.restore();
  }
});

test("drops are logged with a reason: sender-gate, no-run-id, send-failed, expired", async () => {
  const cap = captureConsole();
  try {
    const store = memoryStore();
    const { handlers } = register({ store });
    const reply = (ctx, runId = "r") =>
      handlers.get("reply_payload_sending")(
        { payload: { text: envelopeText() }, kind: "final", channel: "slack", sessionKey: SESSION, runId },
        { channelId: "slack", sessionKey: SESSION, ...ctx },
      );
    const sentOk = (success = true) =>
      handlers.get("message_sent")({ success, sessionKey: SESSION, messageId: "1768996900.000200" }, { channelId: "slack", sessionKey: SESSION });
    reply({ senderId: "U0OTHER" });
    reply({ senderId: SENDER }, undefined);
    handlers.get("reply_payload_sending")(
      { payload: { text: envelopeText() }, kind: "final", channel: "slack", sessionKey: SESSION },
      { channelId: "slack", sessionKey: SESSION, senderId: SENDER },
    );
    reply({ senderId: SENDER });
    await sentOk(false);
    await sentOk(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.rows.size, 0);
    const text = cap.lines.map(([, m]) => m).join("\n");
    for (const expected of [/dropped: sender-gate/u, /dropped: no-run-id/u, /dropped: send-failed/u, /message_sent ignored: nothing pending/u]) {
      assert.match(text, expected);
    }
  } finally {
    cap.restore();
  }
});

test("store failures reach the console as warnings", async () => {
  const cap = captureConsole();
  try {
    const ctx = { channelId: "slack", sessionKey: SESSION, agentId: "debugger", senderId: SENDER, runId: "r" };
    const bad = register({
      store: { lookup: async () => { throw new Error("nope"); }, register: async () => {}, entries: async () => { throw new Error("nope"); } },
    });
    await bad.handlers.get("before_prompt_build")({ prompt: "checkout api create order upstream timeout" }, ctx);
    const warnings = cap.lines
      .filter(([l]) => l === "warn")
      .map(([, m]) => m)
      .filter((m) => !/\] (trace |registered: )/u.test(m));
    assert.deepEqual(warnings, ["[livex-investigations-lite] store read failed: nope"]);
  } finally {
    cap.restore();
  }
});
