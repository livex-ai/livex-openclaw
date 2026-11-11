import { expect, it, vi } from "vitest";
import { notifyReceipt, reconcileNotifications } from "./notifications.js";
import { createReceiptStore } from "./state.js";
import { alert, config, finding, nativeStore, now, slackStub } from "./test-support.js";
import type { Finding, Receipt, Roster } from "./types.js";

async function setup(findings: Finding[]) {
  const { store, source } = nativeStore();
  await store.admit(alert);
  await store.change(alert.key, (receipt) => ({ ...receipt, phase: "assessed", findings }));
  let clock = now;
  const slack = slackStub();
  const health = vi.fn();
  const context = {
    store,
    settlementStore: store,
    slack,
    config,
    now,
    clock: () => clock,
    health,
    assertCurrent() {},
  };
  const tick = async (at = clock, roster: Roster = { p1: "U123456", p2: "U765432" }) => {
    clock = at;
    await notifyReceipt((await store.list())[0]!, roster, { ...context, now: at });
  };
  return {
    source,
    store,
    slack,
    tick,
    health,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

it("suppresses all known Critical paging while unknown findings page with sanitized evidence", async () => {
  const app = await setup([
    { ...finding, classification: "known" },
    { ...finding, id: "two", classification: "unknown", priority: "Medium" },
  ]);
  await app.tick();
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  const texts = vi.mocked(app.slack.send).mock.calls.map(([input]) => input.text);
  expect(vi.mocked(app.slack.send).mock.calls[0]?.[0].cards).toHaveLength(2);
  expect(vi.mocked(app.slack.send).mock.calls[1]?.[0].cards).toBeUndefined();
  expect(texts[0]).not.toMatch(/<@|<!|@channel/);
  expect(texts[1]!.match(/<@/g)).toHaveLength(1);
  expect(texts[1]).toContain("<@U123456>");
  expect(texts[1]).not.toContain("<@U666666>");
  await app.tick(now + 4_500_000);
  expect(app.slack.send).toHaveBeenCalledTimes(3);
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].channel).toBeUndefined();
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("reminder 1");
  await app.tick(now + 4_560_000);
  expect(app.slack.send).toHaveBeenCalledTimes(3);
});

it("anchors t0 after a slow confirmed transport and never starts it without a roster", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  await app.tick(now, {});
  expect((await app.store.list())[0]!.findings?.[0]?.notifiedAt).toBeUndefined();
  vi.mocked(app.slack.send).mockImplementationOnce(async () => {
    app.setClock(now + 120_000);
    return "1794045720.000001";
  });
  await app.tick();
  expect((await app.store.list())[0]!.findings?.[0]?.notifiedAt).toBe(now + 120_000);
  await app.tick(now + 600_000);
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  await app.tick(now + 720_000);
  expect(app.slack.send).toHaveBeenCalledTimes(3);
});

it("keeps a compact summary when findings contain more links than Slack can display", async () => {
  const evidence = Array.from(
    { length: 10 },
    (_, index) => `https://console.cloud.google.com/logs/query?query=${index}${"x".repeat(650)}`,
  );
  const app = await setup([{ ...finding, classification: "unknown", evidence }]);
  await app.tick(now, {});
  const sent = vi.mocked(app.slack.send).mock.lastCall?.[0];
  expect(sent?.cards).toHaveLength(1);
  expect(sent?.text).toContain("8 evidence links omitted to fit Slack");
  expect(sent?.text).toContain(evidence[0]);
  expect(sent?.text).toContain("Checked window unknown");
});

it("persists every reminder tier and spaces delayed recovery by the last confirmed delivery", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  await app.tick();
  await app.tick(now + 4_500_000);
  const reopened = createReceiptStore(app.source, "test-source");
  expect((await reopened.list())[0]?.findings?.[0]?.step).toBe(1);
  await reconcileNotifications(reopened);
  await app.tick(now + 4_560_000);
  expect(app.slack.send).toHaveBeenCalledTimes(3);
  for (let step = 2; step <= 7; step++) {
    await app.tick(now + 4_500_000 + (step - 1) * 600_000);
    const stored = (await reopened.list())[0]?.findings?.[0];
    expect(stored?.step).toBe(step);
    const post = vi.mocked(app.slack.send).mock.lastCall![0];
    expect(post.channel).toBe(step === 7 ? config.broadcastChannelId : undefined);
    expect(post.text.includes("<@U765432>")).toBe(step >= 4);
  }
  expect(app.slack.send).toHaveBeenCalledTimes(9);
});

it("uses P2 immediately when P1 is missing and rechecks original-message acknowledgement", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  await app.tick(now, { p2: "U765432" });
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("<@U765432>");
  vi.mocked(app.slack.acknowledged).mockResolvedValue(true);
  await app.tick(now + 1_200_000);
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  expect(app.slack.acknowledged).toHaveBeenCalledWith(alert.ts);
});

it("retries paging on a later tick when the final acknowledgment read fails before send", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  vi.mocked(app.slack.acknowledged)
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("Slack identity lookup failed"));
  await expect(app.tick()).rejects.toThrow("Slack identity lookup failed");
  expect(app.slack.send).toHaveBeenCalledTimes(1); // Summary only.
  expect((await app.store.list())[0]?.findings?.[0]?.delivery).toBeUndefined();

  await app.tick(now + 60_000);
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  expect((await app.store.list())[0]?.findings?.[0]?.delivery?.status).toBe("confirmed");
});

it.each(["internal_error", "request_timeout"])(
  "freezes ambiguous %s without retry or t0",
  async (error) => {
    const app = await setup([{ ...finding, classification: "unknown" }]);
    vi.mocked(app.slack.send)
      .mockResolvedValueOnce("summary")
      .mockRejectedValue({ code: "slack_webapi_platform_error", data: { error } });
    await app.tick();
    await app.tick(now + 60_000);
    const stored = (await app.store.list())[0]!;
    expect(stored.findings?.[0]?.delivery?.status).toBe("uncertain");
    expect(stored.findings?.[0]?.notifiedAt).toBeUndefined();
    expect(app.slack.send).toHaveBeenCalledTimes(2);
    expect(app.health).toHaveBeenCalled();
  },
);

it("retries definite rejected sends on later ticks only and caps attempts at three", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  vi.mocked(app.slack.send)
    .mockResolvedValueOnce("summary")
    .mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: "missing_scope" } });
  await app.tick();
  await app.tick();
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  await app.tick(now + 60_000);
  await app.tick(now + 120_000);
  await app.tick(now + 180_000);
  expect(app.slack.send).toHaveBeenCalledTimes(4);
  expect((await app.store.list())[0]!.findings?.[0]?.delivery?.status).toBe("failed");
});

it("reconciles restart reservations into visible nonpaging dispatch recovery without redispatch", async () => {
  const app = await setup([]);
  await app.store.change(alert.key, (receipt): Receipt => ({
    ...receipt,
    phase: "dispatch_reserved",
    runId: "old",
  }));
  const reopened = createReceiptStore(app.source, "test-source");
  const health = vi.fn();
  await reconcileNotifications(reopened, health);
  expect(health).toHaveBeenCalledOnce();
  const receipt = (await reopened.list())[0]!;
  expect(receipt.phase).toBe("dispatch_uncertain");
  await app.tick();
  expect(app.slack.send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("uncertain after restart");
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).not.toContain("<@");
});

it("settles a confirmed Slack delivery after its tick is cancelled", async () => {
  const { store, open } = nativeStore();
  const occurrence = new AbortController();
  const assertCurrent = () => occurrence.signal.throwIfAborted();
  const slack = slackStub();
  vi.mocked(slack.send).mockImplementation(async () => {
    occurrence.abort();
    return "1794045601.000001";
  });
  await store.admit(alert);
  const receipt = await store.change(alert.key, (current) => ({
    ...current,
    phase: "assessed",
    findings: [{ ...finding, classification: "known" }],
  }));
  await notifyReceipt(
    receipt,
    {},
    {
      store: createReceiptStore(open(assertCurrent), "test-source"),
      settlementStore: store,
      slack,
      config,
      now,
      clock: () => now,
      health: vi.fn(),
      assertCurrent,
    },
  );
  expect((await store.list())[0]?.summary).toMatchObject({
    status: "confirmed",
    messageTs: "1794045601.000001",
  });
  expect(slack.send).toHaveBeenCalledOnce();
});

it("releases a page reservation when cancellation happens before calling Slack", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  const occurrence = new AbortController();
  const store = createReceiptStore(app.source, "test-source");
  const change = store.change;
  vi.spyOn(store, "change").mockImplementation(async (...args) => {
    const receipt = await change(...args);
    if (receipt.findings?.[0]?.delivery?.status === "reserved") {
      occurrence.abort(new Error("Automation paused before send"));
    }
    return receipt;
  });
  await expect(
    notifyReceipt(
      (await app.store.list())[0]!,
      { p1: "U123456" },
      {
        store,
        settlementStore: app.store,
        slack: app.slack,
        config,
        now,
        clock: () => now,
        health: app.health,
        assertCurrent: () => occurrence.signal.throwIfAborted(),
      },
    ),
  ).rejects.toThrow("Automation paused before send");

  expect(app.slack.send).toHaveBeenCalledOnce();
  expect((await app.store.list())[0]?.findings?.[0]?.delivery).toBeUndefined();
  await app.tick(now + 60_000);
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("<@U123456>");
});
