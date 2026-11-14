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

function register(state) {
  const factories = new Map();
  const handlers = new Map();
  const opened = [];
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
    on: (name, handler) => handlers.set(name, handler),
  });
  return { factories, handlers, opened };
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
