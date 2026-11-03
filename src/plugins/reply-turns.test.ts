import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginInstance, hasCurrentPluginInstanceAuthority } from "./plugin-instance-scope.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type {
  ReplyTurnDeliveryHost,
  ReplyTurnInput,
  ReplyTurnProvider,
} from "./reply-turn.types.js";
import {
  prepareAgentReplyTurn,
  resolveReplyTurnProviderFromRegistry,
} from "./reply-turns.runtime.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function input(overrides: Partial<ReplyTurnInput> = {}): ReplyTurnInput {
  return {
    config: {},
    agentId: "oncall",
    channel: "slack",
    accountId: "primary",
    workspaceId: "workspace",
    nativeChannelId: "channel",
    senderId: "sender",
    sessionKey: "agent:oncall:slack:channel",
    isDirectMessage: false,
    query: "bounded alert",
    assertCurrent() {},
    ...overrides,
  };
}

function fixture() {
  const builder = createTestPluginRegistry();
  const register = (id: string) => {
    const record = createOwnershipRecord(id);
    record.status = "loaded";
    builder.registry.plugins.push(record);
    return { record, api: builder.createApi(record, { config: {} }) };
  };
  return { builder, register };
}

function provider(id = "investigations", agentId = "oncall"): ReplyTurnProvider {
  return { id, agentIds: [agentId], channels: ["slack"], prepare: async () => undefined };
}

function host(): ReplyTurnDeliveryHost {
  return {
    sourceMessageIds: [],
    resolvePermalink: async () => "https://example.invalid/receipt",
    annotateAcceptedFinal: async () => {},
    reportError() {},
    deliver: async () => ({ visibleReplySent: true }),
  };
}

describe("scoped reply turn providers", () => {
  it("selects only the exact agent/channel and ignores a disabled owner", async () => {
    const { builder, register } = fixture();
    const owner = register("owner");
    const prepare = vi.fn(async () => undefined);
    owner.api.registerReplyTurnProvider({ ...provider(), prepare });
    await withPluginRuntimeRegistryScope(builder.registry, async () => {
      await prepareAgentReplyTurn(input({ agentId: "other" }));
      await prepareAgentReplyTurn(input({ channel: "telegram" }));
      expect(prepare).not.toHaveBeenCalled();
      await prepareAgentReplyTurn(input());
      expect(prepare).toHaveBeenCalledOnce();
      owner.record.enabled = false;
      owner.record.status = "disabled";
      await prepareAgentReplyTurn(input());
      expect(prepare).toHaveBeenCalledOnce();
    });
    await disposePluginRegistryInstances(builder.registry);
  });

  it.each([false, true])(
    "fails closed on overlapping owners regardless of order (%s)",
    async (reverse) => {
      const { builder, register } = fixture();
      const owners = [register("one"), register("two")];
      if (reverse) {
        owners.reverse();
      }
      owners[0]!.api.registerReplyTurnProvider(provider("first"));
      owners[1]!.api.registerReplyTurnProvider(provider("second"));
      expect(
        resolveReplyTurnProviderFromRegistry(builder.registry, "oncall", "slack"),
      ).toBeUndefined();
      expect(builder.registry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("already registered"),
          }),
        ]),
      );
      await disposePluginRegistryInstances(builder.registry);
    },
  );

  it("keeps data plain and every nested lifecycle/delivery callback in its exact live instance", async () => {
    const { builder, register } = fixture();
    const owner = register("owned");
    const calls: string[] = [];
    const current = (event: string) => {
      expect(hasCurrentPluginInstanceAuthority("owned")).toBe(true);
      calls.push(event);
    };
    const bindings = { investigation: { turnId: "one" } };
    owner.api.registerReplyTurnProvider({
      ...provider(),
      async prepare(context) {
        current("prepare");
        return {
          context: "saved context",
          toolBindings: bindings,
          assertCurrent() {
            context.assertCurrent();
            current("current");
          },
          lifecycle() {
            current("lifecycle");
            return {
              onAdopted() {
                current("adopted");
              },
              onDeferred() {
                current("deferred");
              },
              onSettled() {
                current("settled");
              },
            };
          },
          releaseImmediate() {
            current("released");
          },
          createDelivery(transport) {
            current("delivery factory");
            return {
              async deliver(payload, info) {
                current("deliver");
                return transport.deliver(payload, info);
              },
              queuedCorrelation: {
                begin() {
                  current("begin");
                  return () => current("queue settled");
                },
                prepareReply(payload) {
                  current("projection");
                  return payload;
                },
                onReplyDelivered() {
                  current("receipt");
                },
              },
            };
          },
        };
      },
    });
    const prepared = await withPluginRuntimeRegistryScope(builder.registry, () =>
      prepareAgentReplyTurn(input()),
    );
    expect(prepared).toBeDefined();
    if (!prepared) {
      throw new Error("Expected prepared turn");
    }
    expect(prepared.toolBindings).toBe(bindings);
    expect(structuredClone(prepared.toolBindings)).toEqual(bindings);
    prepared.assertCurrent();
    const lifecycle = prepared.lifecycle();
    await lifecycle.onAdopted();
    lifecycle.onDeferred?.();
    const delivery = prepared.createDelivery(host());
    const settle = delivery.queuedCorrelation?.begin();
    delivery.queuedCorrelation?.prepareReply?.({ text: "final" }, { kind: "final" });
    await delivery.queuedCorrelation?.onReplyDelivered?.(
      { text: "final" },
      { kind: "final", complete: true },
    );
    await delivery.deliver({ text: "final" }, { kind: "final" });
    settle?.({ visibleReplySent: true, failed: false, completed: true });
    await lifecycle.onSettled?.();
    prepared.releaseImmediate();
    expect(calls).toContain("queue settled");
    await disposePluginRegistryInstances(builder.registry);
    const before = [...calls];
    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => lifecycle.onDeferred?.()).toThrow();
    expect(() =>
      delivery.queuedCorrelation?.prepareReply?.({ text: "late" }, { kind: "final" }),
    ).toThrow();
    await expect(async () =>
      delivery.deliver({ text: "late" }, { kind: "final" }),
    ).rejects.toThrow();
    expect(calls).toEqual(before);
  });

  it.each(["authority", "abort"] as const)(
    "releases a prepared handle when %s expires during the awaited lookup",
    async (reason) => {
      const { builder, register } = fixture();
      const owner = register("owner");
      const ready = createDeferredCore();
      const finish = createDeferredCore();
      const abort = new AbortController();
      const releaseImmediate = vi.fn();
      let current = true;
      owner.api.registerReplyTurnProvider({
        ...provider(),
        async prepare() {
          ready.resolve();
          await finish.promise;
          return {
            context: "saved context",
            toolBindings: {},
            assertCurrent() {},
            lifecycle: () => ({ onAdopted() {} }),
            releaseImmediate,
            createDelivery: (transport) => ({ deliver: transport.deliver }),
          };
        },
      });
      const pending = withPluginRuntimeRegistryScope(builder.registry, () =>
        prepareAgentReplyTurn(
          input({
            signal: abort.signal,
            assertCurrent() {
              if (!current) {
                throw new Error("ingress retired");
              }
            },
          }),
        ),
      );
      await ready.promise;
      if (reason === "authority") {
        current = false;
      } else {
        abort.abort(new Error("ingress retired"));
      }
      finish.resolve();
      await expect(pending).rejects.toThrow("ingress retired");
      expect(releaseImmediate).toHaveBeenCalledOnce();
      await disposePluginRegistryInstances(builder.registry);
    },
  );

  it.each(["quiesce", "dispose"] as const)(
    "settles deferred host custody once after managed owner %s without retired plugin effects",
    async (retirement) => {
      const { builder, register } = fixture();
      const owner = register("owner");
      const pluginTerminal = vi.fn();
      owner.api.registerReplyTurnProvider({
        ...provider(),
        async prepare() {
          return {
            context: "saved context",
            toolBindings: {},
            assertCurrent() {},
            lifecycle: (upstream) => ({
              ...upstream,
              onAdopted: async () => upstream?.onAdopted(),
              onAbandoned: async () => {
                pluginTerminal("abandoned");
                await upstream?.onAbandoned?.();
              },
              onSettled: async () => {
                pluginTerminal("settled");
                await upstream?.onSettled?.();
              },
            }),
            releaseImmediate() {},
            createDelivery: (transport) => ({ deliver: transport.deliver }),
          };
        },
      });
      const prepared = await withPluginRuntimeRegistryScope(builder.registry, () =>
        prepareAgentReplyTurn(input()),
      );
      expect(prepared).toBeDefined();
      const upstream = {
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
        onSettled: vi.fn(),
      };
      const lifecycle = prepared!.lifecycle(upstream);
      lifecycle.onDeferred?.();
      if (retirement === "quiesce") {
        getPluginInstance(owner.record)!.quiesce();
      } else {
        await disposePluginRegistryInstances(builder.registry);
      }
      try {
        await lifecycle.onAbandoned?.();
        await lifecycle.onAbandoned?.();
        await Promise.all([lifecycle.onSettled?.(), lifecycle.onSettled?.()]);
        expect(upstream.onAbandoned).toHaveBeenCalledOnce();
        expect(upstream.onSettled).toHaveBeenCalledOnce();
        expect(pluginTerminal).not.toHaveBeenCalled();
        expect(() => lifecycle.onDeferred?.()).toThrow(/reloaded or disabled/);
      } finally {
        await disposePluginRegistryInstances(builder.registry);
      }
    },
  );

  it("preserves an accepted final when its managed provider retires before host release", async () => {
    const { builder, register } = fixture();
    const owner = register("owner");
    const releaseImmediate = vi.fn();
    owner.api.registerReplyTurnProvider({
      ...provider(),
      async prepare() {
        return {
          context: "saved context",
          toolBindings: {},
          assertCurrent() {},
          lifecycle: () => ({ onAdopted() {} }),
          releaseImmediate,
          createDelivery: (transport) => ({ deliver: transport.deliver }),
        };
      },
    });
    const prepared = await withPluginRuntimeRegistryScope(builder.registry, () =>
      prepareAgentReplyTurn(input()),
    );
    expect(prepared).toBeDefined();
    const delivery = prepared!.createDelivery(host());
    const dispatch = async () => {
      try {
        const accepted = await delivery.deliver({ text: "done" }, { kind: "final" });
        await disposePluginRegistryInstances(builder.registry);
        return accepted;
      } finally {
        prepared!.releaseImmediate();
      }
    };
    await expect(dispatch()).resolves.toEqual({ visibleReplySent: true });
    expect(releaseImmediate).not.toHaveBeenCalled();
  });

  it.each([
    new Error("plugin cleanup failed"),
    Object.assign(new Error("name-spoofed cleanup failure"), {
      name: "PluginInstanceUnavailableError",
    }),
    new PluginInstanceUnavailableError("still-live"),
  ])("preserves live plugin cleanup errors and settles host custody once: %s", async (failure) => {
    const { builder, register } = fixture();
    const owner = register("owner");
    const hostFailure = new Error("host cleanup failed");
    const onSettled = vi.fn(async () => {
      throw hostFailure;
    });
    owner.api.registerReplyTurnProvider({
      ...provider(),
      async prepare() {
        return {
          context: "saved context",
          toolBindings: {},
          assertCurrent() {},
          lifecycle: () => ({
            onAdopted() {},
            onSettled() {
              throw failure;
            },
          }),
          releaseImmediate() {
            throw failure;
          },
          createDelivery: (transport) => ({ deliver: transport.deliver }),
        };
      },
    });
    try {
      const prepared = await withPluginRuntimeRegistryScope(builder.registry, () =>
        prepareAgentReplyTurn(input()),
      );
      expect(prepared).toBeDefined();
      const lifecycle = prepared!.lifecycle({ onAdopted() {}, onSettled });
      await expect(lifecycle.onSettled?.()).rejects.toMatchObject({
        errors: [failure, hostFailure],
      });
      await expect(lifecycle.onSettled?.()).rejects.toMatchObject({
        errors: [failure, hostFailure],
      });
      expect(onSettled).toHaveBeenCalledOnce();
      expect(() => prepared!.releaseImmediate()).toThrow(failure);
    } finally {
      await disposePluginRegistryInstances(builder.registry);
    }
  });

  it.each([false, true])(
    "preserves upstream-first settlement when live plugin cleanup throws afterward: %s",
    async (failAfterHost) => {
      const { builder, register } = fixture();
      const owner = register("owner");
      const events: string[] = [];
      const failure = new Error("plugin failed after host settlement");
      owner.api.registerReplyTurnProvider({
        ...provider(),
        async prepare() {
          return {
            context: "saved context",
            toolBindings: {},
            assertCurrent() {},
            lifecycle: (upstream) => ({
              onAdopted() {},
              async onSettled() {
                events.push("plugin-start");
                await upstream?.onSettled?.();
                events.push("plugin-finish");
                if (failAfterHost) {
                  throw failure;
                }
              },
            }),
            releaseImmediate() {},
            createDelivery: (transport) => ({ deliver: transport.deliver }),
          };
        },
      });
      try {
        const prepared = await withPluginRuntimeRegistryScope(builder.registry, () =>
          prepareAgentReplyTurn(input()),
        );
        const lifecycle = prepared!.lifecycle({
          onAdopted() {},
          onSettled() {
            events.push("host");
          },
        });
        const completed = Promise.all([lifecycle.onSettled?.(), lifecycle.onSettled?.()]);
        if (failAfterHost) {
          await expect(completed).rejects.toBe(failure);
        } else {
          await completed;
        }
        expect(events).toEqual(["plugin-start", "host", "plugin-finish"]);
      } finally {
        await disposePluginRegistryInstances(builder.registry);
      }
    },
  );

  it("captures the additive capability without executing preparation", () => {
    const captured = createCapturedPluginRegistration();
    const value = provider();
    captured.api.registerReplyTurnProvider(value);
    expect(captured.replyTurnProviders).toEqual([value]);
  });
});
