import { expect, it, vi } from "vitest";
import { parseOncallConfig } from "./config.js";
import { admitAlert, isEligibleMessage, scanAlerts } from "./intake.js";
import { createReceiptStore } from "./state.js";
import { alert, config, message, nativeStore, now, slackStub } from "./test-support.js";

it("admits same-app trusted roots but rejects coordinator output, replies and forged publishers", () => {
  expect(isEligibleMessage(message, config)).toBe(true);
  for (const patch of [
    { metadata: { event_type: "livex_oncall" } },
    { text: "\u2063output" },
    { thread_ts: "1794045590.000001" },
    { bot_id: "B666666", username: "Trusted publisher" },
    { team: "T666666" },
  ]) {
    expect(isEligibleMessage({ ...message, ...patch }, config)).toBe(false);
  }
  expect(admitAlert(message, config, now)?.identifiers).toEqual({ jobId: "job-1" });
});

it("clamps old checkpoints, preserves queued admissions and paginates without skipping", async () => {
  const { store } = nativeStore();
  await store.advance("1700000000.000000");
  const slack = slackStub();
  vi.mocked(slack.history)
    .mockResolvedValueOnce({ messages: [message], cursor: "next" })
    .mockResolvedValueOnce({
      messages: [{ ...message, metadata: { event_type: "livex_oncall" } }],
    });
  await scanAlerts({ config, store, slack, now, assertCurrent() {} });
  expect(slack.history).toHaveBeenNthCalledWith(1, ((now - 900_000) / 1000).toFixed(6), undefined);
  expect(slack.history).toHaveBeenNthCalledWith(2, ((now - 900_000) / 1000).toFixed(6), "next");
  expect(await store.list()).toHaveLength(1);
  await scanAlerts({ config, store, slack, now: now + 2_000_000, assertCurrent() {} });
  expect((await store.list())[0]!.alert.key).toBe(alert.key);
});

it("retains checkpoint on incomplete pagination and rejects overbroad resource config", async () => {
  const { store } = nativeStore();
  const slack = slackStub();
  vi.mocked(slack.history).mockResolvedValue({ messages: [message], cursor: "more" });
  await expect(
    scanAlerts({ config: { ...config, maxScanPages: 1 }, store, slack, now, assertCurrent() {} }),
  ).rejects.toThrow("incomplete");
  expect(await store.checkpoint()).toBeUndefined();
  expect(() => parseOncallConfig({ ...config, resourceLabels: {} })).toThrow();
  expect(() => parseOncallConfig({ ...config, maxRunMs: 600_001 })).toThrow();
  expect(parseOncallConfig(undefined)).toBeNull();
});

it("fails closed at native receipt capacity and preserves the existing durable receipt", async () => {
  const { store } = nativeStore(1);
  await store.admit(alert);
  await expect(store.admit({ ...alert, key: `${alert.key}2` })).rejects.toThrow();
  expect(await store.list()).toHaveLength(1);
});

it("admits alerts arriving during history awaits without advancing past deferred future roots", async () => {
  const { store } = nativeStore();
  const slack = slackStub();
  let clock = now;
  const arriving = { ...message, ts: ((now + 5_000) / 1000).toFixed(6) };
  const future = { ...message, ts: ((now + 60_000) / 1000).toFixed(6) };
  vi.mocked(slack.history).mockImplementationOnce(async () => {
    clock += 5_000;
    return {
      messages: [
        future,
        {
          ...future,
          ts: ((now + 120_000) / 1000).toFixed(6),
          metadata: { event_type: "livex_oncall" },
        },
        arriving,
      ],
    };
  });
  const params = { config, store, slack, now, clock: () => clock, assertCurrent() {} };
  await scanAlerts(params);
  expect((await store.list())[0]?.alert.ts).toBe(arriving.ts);
  expect(await store.checkpoint()).toBe(arriving.ts);
  clock = now + 60_000;
  vi.mocked(slack.history).mockResolvedValueOnce({ messages: [future] });
  await scanAlerts({ ...params, now: clock });
  expect(await store.list()).toHaveLength(2);
  expect(await store.checkpoint()).toBe(future.ts);
});

it("admits one typed receipt per producer incident across scans and restart", async () => {
  const { store, open } = nativeStore();
  const slack = slackStub();
  const typed = { ...config, alertEventTypes: ["gcp_monitoring_incident"] };
  const event = (offset: number, type: string, id: unknown) => ({
    ...message,
    ts: ((now - offset) / 1000).toFixed(6),
    metadata: { event_type: type, event_payload: { incident_id: id } },
  });
  const first = event(900, "gcp_monitoring_incident", "gcp_incident_1");
  const duplicate = event(800, "gcp_monitoring_incident", "gcp_incident_1");
  const next = event(700, "gcp_monitoring_incident", "gcp_incident_2");
  const ignored = [
    event(600, "device_recovered", "gcp_incident_3"),
    event(500, "device_offline", "gcp_incident_4"),
    event(400, "gcp_monitoring_incident", undefined),
    event(300, "gcp_monitoring_incident", "x".repeat(257)),
  ];
  const scan = (receiptStore = store) =>
    scanAlerts({ config: typed, store: receiptStore, slack, now, assertCurrent() {} });
  vi.mocked(slack.history)
    .mockResolvedValueOnce({ messages: [next, duplicate, ...ignored], cursor: "older" })
    .mockResolvedValueOnce({ messages: [first] })
    .mockResolvedValueOnce({
      messages: [event(100, "gcp_monitoring_incident", "gcp_incident_1")],
    });
  await scan();
  const reopened = createReceiptStore(
    open(() => {}),
    "test-source",
  );
  await scan(reopened);
  expect((await reopened.list()).map((receipt) => receipt.alert.ts).toSorted()).toEqual([
    first.ts,
    next.ts,
  ]);
});
