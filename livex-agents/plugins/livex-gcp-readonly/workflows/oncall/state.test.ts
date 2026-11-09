import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { createCoordinator } from "./service.js";
import { createReceiptScope, createReceiptStore } from "./state.js";
import {
  alert,
  config,
  finding,
  gcpConfig,
  message,
  nativeStore,
  now,
  slackStub,
} from "./test-support.js";

it("binds selected semantic source facts while budgets and resource-label ordering preserve incident identity", () => {
  const source = {
    ...config,
    resourceLabels: { namespace_name: "prd-worker", cluster_name: "prd" },
  };
  const identity = createReceiptScope(source, gcpConfig, "catalog-a");
  const reordered = {
    ...source,
    resourceLabels: { cluster_name: "prd", namespace_name: "prd-worker" },
    maxRunMs: 1000,
    maxLogCalls: 1,
    maxLogBytes: 1000,
    reminderMs: 1000,
  };
  expect(createReceiptScope(reordered, gcpConfig, "catalog-a")).toBe(identity);
  const changes = [
    { accountId: "other" },
    { teamId: "T765432" },
    { channelId: "C765432" },
    { publisherBotId: "B765432" },
    { environment: "stg" },
    { historicalSenderId: "U765432" },
    { resourceLabels: { namespace_name: "stg-worker" } },
  ];
  for (const change of changes) {
    expect(createReceiptScope({ ...source, ...change }, gcpConfig, "catalog-a")).not.toBe(identity);
  }
  expect(
    createReceiptScope(source, { ...gcpConfig, project: "example-stg" }, "catalog-a"),
  ).not.toBe(identity);
  expect(createReceiptScope(source, gcpConfig, "catalog-disabled")).not.toBe(identity);
});

it("quarantines foreign and legacy receipts across source restart without replaying a globally admitted Slack event", async () => {
  const { source } = nativeStore();
  const sourceA = createReceiptScope(config, gcpConfig, "catalog-a");
  const sourceB = createReceiptScope(config, { ...gcpConfig, project: "other-prd" }, "catalog-a");
  const first = createReceiptStore(source, sourceA);
  await first.admit(alert);
  const assessed = { ...alert, key: `${alert.key}assessed`, ts: ((now - 1000) / 1000).toFixed(6) };
  await first.admit(assessed);
  await first.change(assessed.key, (receipt) => ({
    ...receipt,
    phase: "assessed",
    findings: [
      {
        ...finding,
        classification: "unknown",
        notifiedAt: now - 600_000,
        lastNotifiedAt: now - 600_000,
        step: 0,
      },
    ],
    summary: { status: "confirmed", step: 0, attempts: 1, tick: now },
  }));
  await first.advance(message.ts);
  // Decode a historical wire row without a source identity; it must never be adopted.
  const legacy = JSON.parse(
    '{"phase":"queued","alert":{"key":"alert:legacy","text":"private legacy incident","ts":"1794045599.000001"}}',
  );
  await source.register("alert:legacy", legacy);
  const quarantine = vi.fn();
  const second = createReceiptStore(source, sourceB, quarantine);
  expect(await second.list()).toEqual([]);
  expect(await second.checkpoint()).toBeUndefined();
  await expect(
    second.change(alert.key, (receipt) => ({ ...receipt, phase: "assessed" })),
  ).rejects.toThrow("current source");
  await second.admit(alert);
  expect(await second.list()).toEqual([]);
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const slack = slackStub();
  vi.mocked(slack.history).mockResolvedValue({ messages: [message] });
  const investigate = vi.fn(async () => ({ findings: [finding] }));
  const coordinator = createCoordinator({
    config,
    store: second,
    scheduler,
    investigate,
    catalog: { lookup: async () => [{ classification: "unknown" }] },
    assertCurrent() {},
    health: vi.fn(),
  });
  const scope = { store: second, slack, assertCurrent() {} };
  try {
    await coordinator.tick(scope);
    await coordinator.tick(scope);
    expect(investigate).not.toHaveBeenCalled();
    expect(slack.send).not.toHaveBeenCalled();
    expect(slack.acknowledged).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine).toHaveBeenCalledWith(3);
    await expect(
      first.change(alert.key, (receipt) => ({ ...receipt, phase: "assessed" })),
    ).rejects.toThrow("current source");
    const newMessage = { ...message, ts: ((now + 60_000) / 1000).toFixed(6) };
    time.setTime(now + 60_000);
    vi.mocked(slack.history).mockResolvedValue({ messages: [newMessage] });
    await coordinator.tick(scope);
    await time.wake();
    await vi.waitFor(() => expect(investigate).toHaveBeenCalledOnce());
    await coordinator.tick(scope);
    expect(slack.send).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(slack.send).mock.calls.every(([post]) => post.threadTs === newMessage.ts),
    ).toBe(true);
    expect(vi.mocked(slack.acknowledged).mock.calls.every(([ts]) => ts === newMessage.ts)).toBe(
      true,
    );
    const restored = createReceiptStore(source, sourceA);
    expect(await restored.list()).toEqual([]);
    await restored.admit(alert);
    expect(await restored.list()).toEqual([]);
    await expect(
      restored.change(alert.key, (receipt) => ({ ...receipt, phase: "assessed" })),
    ).rejects.toThrow("current source");
    const restoredSlack = slackStub();
    const restoredRun = vi.fn(async () => ({ findings: [finding] }));
    await createCoordinator({
      config,
      store: restored,
      scheduler,
      investigate: restoredRun,
      catalog: { lookup: async () => [{ classification: "unknown" }] },
      assertCurrent() {},
      health: vi.fn(),
    }).tick({ store: restored, slack: restoredSlack, assertCurrent() {} });
    await time.wake();
    expect(restoredRun).not.toHaveBeenCalled();
    expect(restoredSlack.send).not.toHaveBeenCalled();
    expect(restoredSlack.acknowledged).not.toHaveBeenCalled();
    expect((await source.lookup("alert:legacy"))?.sourceId).toBeUndefined();
    expect((await source.lookup("alert:legacy"))?.quarantined).toBe(true);
  } finally {
    await scheduler.stop();
    await gateway.stop();
  }
});
