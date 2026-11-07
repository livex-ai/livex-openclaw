import { expect, it, vi } from "vitest";
import { notifyReceipt, reconcileNotifications } from "./notifications.js";
import { createReceiptStore } from "./state.js";
import { alert, config, finding, nativeStore, now, slackStub } from "./test-support.js";
import type { Finding, Receipt, Roster } from "./types.js";

it("reacquires roster after awaited acknowledgment crosses a shift and rerenders targets", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  vi.mocked(app.slack.acknowledged).mockImplementation(async () => {
    app.setClock(now + 20_000);
    return false;
  });
  vi.mocked(app.slack.roster).mockResolvedValue({
    p1: "W765432",
    provider: "googleCalendar",
    validUntil: now + 60_000,
  });
  await app.tick(now, { p1: "U123456", provider: "googleCalendar", validUntil: now + 10_000 });
  expect(app.slack.roster).toHaveBeenCalledOnce();
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("<@W765432>");
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).not.toContain("<@U123456>");
});

it("keeps nonpaging handoff independent of missing roster and suppresses expired paging", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  vi.mocked(app.slack.roster).mockResolvedValue({
    provider: "canvas",
    error: "unavailable",
    warning: "Calendar roster unavailable: missing_credentials; using current Canvas",
    validUntil: now - 1,
  });
  await app.tick(now, { p1: "U123456", provider: "googleCalendar", validUntil: now - 1 });
  expect(app.slack.send).toHaveBeenCalledOnce();
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).not.toContain("<@");
  expect((await app.store.list())[0]!.findings?.[0]?.delivery).toMatchObject({
    status: "rejected",
    attempts: 0,
  });
  expect(app.health).toHaveBeenCalledWith(
    "Calendar roster unavailable: missing_credentials; using current Canvas",
  );
});

it.each([
  { old: { p1: "U123456" }, fresh: { p2: "W765432" }, tier: 1 },
  { old: { p2: "U123456" }, fresh: { p1: "W765432" }, tier: 0 },
])("selects and settles fresh roster tier $tier", async ({ old, fresh, tier }) => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  vi.mocked(app.slack.acknowledged).mockImplementation(async () => {
    app.setClock(now + 20_000);
    return false;
  });
  vi.mocked(app.slack.roster).mockResolvedValue({ ...fresh, validUntil: now + 60_000 });
  await app.tick(now, { ...old, validUntil: now + 10_000 });
  expect(vi.mocked(app.slack.send).mock.lastCall?.[0].text).toContain("<@W765432>");
  expect((await app.store.list())[0]!.findings?.[0]?.baseTier).toBe(tier);
});

it("honors acknowledgment arriving during Calendar reacquisition", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  let acknowledged = false;
  vi.mocked(app.slack.acknowledged).mockImplementation(async () => acknowledged);
  vi.mocked(app.slack.roster).mockImplementation(async () => {
    acknowledged = true;
    return { p1: "W765432", validUntil: now + 60_000 };
  });
  await app.tick(now, { p1: "U123456", validUntil: now - 1 });
  expect(app.slack.send).toHaveBeenCalledOnce();
  expect((await app.store.list())[0]!.findings?.[0]?.acknowledged).toBe(true);
});

it("does not settle an engineer page when a fresh roster has no valid mention target", async () => {
  const app = await setup([{ ...finding, classification: "unknown" }]);
  await app.tick(now, { p1: "not-a-slack-id", validUntil: now + 60_000 });
  expect(app.slack.send).toHaveBeenCalledOnce();
  expect((await app.store.list())[0]!.findings?.[0]?.delivery).toMatchObject({
    status: "rejected",
    attempts: 0,
  });
  expect((await app.store.list())[0]!.findings?.[0]?.notifiedAt).toBeUndefined();
});

async function setup(findings: Finding[]) {
  const { store, source } = nativeStore();
  await store.admit(alert);
  await store.change(alert.key, (receipt) => ({ ...receipt, phase: "assessed", findings }));
  let clock = now;
  const slack = slackStub();
  const health = vi.fn();
  const context = { store, slack, config, now, clock: () => clock, health, assertCurrent() {} };
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
    { ...finding, id: "two", classification: "unknown" },
  ]);
  await app.tick();
  expect(app.slack.send).toHaveBeenCalledTimes(2);
  const texts = vi.mocked(app.slack.send).mock.calls.map(([input]) => input.text);
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
