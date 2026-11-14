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

test("envelope auto-record through the entry, store failures reach api.logger", async () => {
  const lines = [];
  const logger = { warn: (m) => lines.push(["warn", m]), info: (m) => lines.push(["info", m]) };
  const store = memoryStore();
  const { handlers } = register({ store }, { logger });
  const ctx = { channelId: "slack", sessionKey: SESSION, agentId: "debugger", senderId: SENDER, runId: "r" };
  await handlers.get("before_prompt_build")({ prompt: "x" }, ctx);
  const payload = {
    text: `LIVEX_ALERT_SUMMARY_V2\n${JSON.stringify({ title: "T", signature: "checkout-api | create order | upstream timeout", priority: "high", provisional: false, summary: "Provider timed out.", nextAction: "Page owner.", owner: "payments", checkedWindow: "30m" })}\n\nfull`,
  };
  const out = handlers.get("reply_payload_sending")({ kind: "final", channel: "slack", sessionKey: SESSION, runId: "r", payload }, ctx);
  assert.equal(out, undefined);
  await handlers.get("message_sent")({ success: true, sessionKey: SESSION, messageId: "1768996900.000200" }, { channelId: "slack", sessionKey: SESSION });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.rows.size, 1);
  assert.ok(lines.some(([l, m]) => l === "info" && /case committed sig=[0-9a-f]{8} occurrences=1/u.test(m)));

  const broken = [];
  const bad = register(
    { store: { lookup: async () => { throw new Error("nope"); }, register: async () => {}, entries: async () => { throw new Error("nope"); } } },
    { logger: { warn: (m) => broken.push(m), info() {} } },
  );
  await bad.handlers.get("before_prompt_build")({ prompt: "checkout api create order upstream timeout" }, ctx);
  assert.deepEqual(broken, ["[livex-investigations-lite] store read failed: nope"]);
});
