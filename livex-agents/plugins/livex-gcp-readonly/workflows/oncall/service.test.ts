import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { createConfigCurrency, createCoordinator } from "./service.js";
import { alert, config, finding, message, nativeStore, now, slackStub } from "./test-support.js";
import type { Assessment } from "./types.js";

it.each(["disable", "retarget", "deny", "disallow", "disable-all"])(
  "revokes old catalog authority on %s without changing GCP source",
  (change) => {
    const source = {
      plugins: {
        enabled: true,
        allow: ["livex-gcp-readonly", "livex-investigations"],
        deny: [] as string[],
        entries: {
          "livex-gcp-readonly": { enabled: true, config: { project: "prd" } },
          "livex-investigations": {
            enabled: true,
            config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
          },
        },
      },
    };
    const assertCurrent = createConfigCurrency(source, () => source);
    assertCurrent();
    const catalog = source.plugins.entries["livex-investigations"];
    if (change === "disable") {
      catalog.enabled = false;
    }
    if (change === "retarget") {
      catalog.config.investigationCatalog.agentId = "other";
    }
    if (change === "deny") {
      source.plugins.deny = ["livex-investigations"];
    }
    if (change === "disallow") {
      source.plugins.allow = ["livex-gcp-readonly"];
    }
    if (change === "disable-all") {
      source.plugins.enabled = false;
    }
    expect(() => assertCurrent()).toThrow("source configuration changed");
  },
);

it("native owned diagnosis remains pending while a later tick pages an existing unknown reminder", async () => {
  const { store } = nativeStore();
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const slack = slackStub();
  vi.mocked(slack.history).mockResolvedValue({
    messages: [
      message,
      { ...message, ts: (now / 1000 - 1).toFixed(6), metadata: { event_type: "livex_oncall" } },
    ],
  });
  const existing = { ...alert, key: `${alert.key}old`, ts: (now / 1000 - 2).toFixed(6) };
  await store.admit(existing);
  await store.change(existing.key, (row) => ({
    ...row,
    phase: "assessed",
    summary: { status: "confirmed", step: 0, tick: now, attempts: 1 },
    findings: [{ ...finding, classification: "unknown", notifiedAt: now, step: 0 }],
  }));
  const investigate = vi.fn(
    (_receipt, _identity, signal: AbortSignal) =>
      new Promise<Assessment>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const assertCurrent = () => scheduler.signal.throwIfAborted();
  const scope = { store, slack, assertCurrent };
  const coordinator = createCoordinator({
    config,
    store,
    scheduler,
    investigate,
    catalog: { lookup: async () => [] },
    assertCurrent,
    health: vi.fn(),
  });
  try {
    await coordinator.tick(scope);
    void time.wake();
    await vi.waitFor(() => expect(investigate).toHaveBeenCalledOnce());
    expect((await store.list()).find((row) => row.alert.key === alert.key)?.phase).toBe(
      "dispatch_reserved",
    );
    time.setTime(now + 600_000);
    await coordinator.tick(scope);
    expect(slack.send).toHaveBeenCalledOnce();
    expect(vi.mocked(slack.send).mock.lastCall?.[0].text).toContain("reminder 1");
    expect(investigate).toHaveBeenCalledOnce();
    expect(await store.list()).toHaveLength(2);
  } finally {
    await scheduler.stop();
    await gateway.stop();
  }
});

it("completes each admission once and skips all Slack reaction calls for a completed known workflow", async () => {
  const { store } = nativeStore();
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const slack = slackStub();
  vi.mocked(slack.history).mockResolvedValue({ messages: [message] });
  const investigate = vi.fn(async () => ({ findings: [finding] }));
  const coordinator = createCoordinator({
    config,
    store,
    scheduler,
    investigate,
    catalog: { lookup: async () => [{ classification: "known" }] },
    assertCurrent() {},
    health: vi.fn(),
  });
  const scope = { store, slack, assertCurrent() {} };
  const occurrence = new AbortController();
  try {
    await coordinator.tick({ ...scope, assertCurrent: () => occurrence.signal.throwIfAborted() });
    occurrence.abort();
    void time.wake();
    await vi.waitFor(async () => expect((await store.list())[0]?.phase).toBe("assessed"));
    await coordinator.tick(scope);
    expect(slack.send).toHaveBeenCalledOnce();
    expect(slack.acknowledged).not.toHaveBeenCalled();
    await coordinator.tick(scope);
    expect(slack.send).toHaveBeenCalledOnce();
    expect(slack.acknowledged).not.toHaveBeenCalled();
    expect(investigate).toHaveBeenCalledOnce();
  } finally {
    await scheduler.stop();
    await gateway.stop();
  }
});

it("runs empty ticks without a model and coalesces overlapping calls", async () => {
  const { store } = nativeStore();
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const slack = slackStub();
  const investigate = vi.fn(async () => ({ findings: [] }));
  const scope = { store, slack, assertCurrent() {} };
  const coordinator = createCoordinator({
    config,
    store,
    scheduler,
    investigate,
    catalog: { lookup: async () => [] },
    assertCurrent() {},
    health: vi.fn(),
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  vi.mocked(slack.verify).mockReturnValueOnce(promise);
  try {
    await coordinator.start();
    await time.wake();
    expect(slack.verify).not.toHaveBeenCalled();
    const first = coordinator.tick(scope);
    await expect(coordinator.tick(scope)).resolves.toBe(false);
    resolve();
    await expect(first).resolves.toBe(true);
    await time.wake();
    expect(slack.verify).toHaveBeenCalledOnce();
    expect(investigate).not.toHaveBeenCalled();
    expect(slack.send).not.toHaveBeenCalled();
  } finally {
    resolve();
    await scheduler.stop();
    await gateway.stop();
  }
});
