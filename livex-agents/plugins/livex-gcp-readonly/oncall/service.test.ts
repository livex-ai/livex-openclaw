import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { createConfigCurrency, createCoordinator } from "./service.js";
import { alert, config, finding, message, nativeStore, now, slackStub } from "./test-support.js";
import type { Assessment } from "./types.js";

it("isolates Calendar credential material from source currency but preserves public identity", () => {
  const calendar = {
    enabled: true,
    calendarId: "rotation",
    oauth: { clientId: "public", clientSecret: "first", refreshToken: "old" },
  };
  const source = {
    plugins: {
      entries: {
        "livex-gcp-readonly": { config: { project: "prd", oncall: { googleCalendar: calendar } } },
      },
    },
  };
  const current = createConfigCurrency(source, () => source);
  calendar.oauth.clientSecret = "rotated";
  calendar.oauth.refreshToken = "rotated";
  expect(current).not.toThrow();
  calendar.calendarId = "different";
  expect(current).toThrow("source configuration changed");
});

it("canonicalizes credentials-only OAuth shape without revoking public source currency", () => {
  const calendar: Record<string, unknown> = { enabled: false };
  const source = {
    plugins: {
      entries: { "livex-gcp-readonly": { config: { oncall: { googleCalendar: calendar } } } },
    },
  };
  const current = createConfigCurrency(source, () => source);
  calendar.oauth = { clientSecret: { source: "env", provider: "default", id: "REF_CANARY" } };
  expect(current).not.toThrow();
  delete calendar.oauth;
  expect(current).not.toThrow();
});

it("treats absent and credentials-only disabled Calendar as the same public source", () => {
  const oncall: Record<string, unknown> = {};
  const source = { plugins: { entries: { "livex-gcp-readonly": { config: { oncall } } } } };
  const current = createConfigCurrency(source, () => source);
  oncall.googleCalendar = { oauth: { refreshToken: "secret-canary" } };
  expect(current).not.toThrow();
});

it("deduplicates the same roster warning across tick selection and notification reacquisition", async () => {
  const { store } = nativeStore();
  await store.admit(alert);
  await store.change(alert.key, (row) => ({
    ...row,
    phase: "assessed",
    findings: [{ ...finding, classification: "unknown" }],
  }));
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const slack = slackStub();
  const warning = "Calendar roster unavailable: missing_credentials; using current Canvas";
  vi.mocked(slack.roster).mockImplementation(async () => ({
    p1: "U123456",
    validUntil: scheduler.now() + 5,
    warning,
  }));
  vi.mocked(slack.acknowledged).mockImplementation(async () => {
    time.setTime(scheduler.now() + 10);
    return false;
  });
  const health = vi.fn();
  const coordinator = createCoordinator({
    config,
    store,
    slack,
    scheduler,
    assertCurrent() {},
    investigate: async () => ({ findings: [] }),
    catalog: { lookup: async () => [] },
    health,
  });
  try {
    await coordinator.tick();
    expect(health.mock.calls.filter(([reported]) => reported === warning)).toHaveLength(1);
  } finally {
    await scheduler.stop();
    await gateway.stop();
  }
});

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
  const coordinator = createCoordinator({
    config,
    store,
    slack,
    scheduler,
    investigate,
    catalog: { lookup: async () => [] },
    assertCurrent() {
      scheduler.signal.throwIfAborted();
    },
    health: vi.fn(),
  });
  try {
    await coordinator.tick();
    void time.wake();
    await vi.waitFor(() => expect(investigate).toHaveBeenCalledOnce());
    expect((await store.list()).find((row) => row.alert.key === alert.key)?.phase).toBe(
      "dispatch_reserved",
    );
    time.setTime(now + 600_000);
    await coordinator.tick();
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
    slack,
    scheduler,
    investigate,
    catalog: { lookup: async () => [{ classification: "known" }] },
    assertCurrent() {},
    health: vi.fn(),
  });
  try {
    await coordinator.tick();
    void time.wake();
    await vi.waitFor(async () => expect((await store.list())[0]?.phase).toBe("assessed"));
    await coordinator.tick();
    expect(slack.send).toHaveBeenCalledOnce();
    expect(slack.acknowledged).not.toHaveBeenCalled();
    await coordinator.tick();
    expect(slack.send).toHaveBeenCalledOnce();
    expect(slack.acknowledged).not.toHaveBeenCalled();
    expect(investigate).toHaveBeenCalledOnce();
  } finally {
    await scheduler.stop();
    await gateway.stop();
  }
});
