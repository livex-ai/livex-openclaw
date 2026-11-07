import { beforeEach, expect, it, vi } from "vitest";
import { createCalendarRoster } from "./calendar.js";
import { createOncallSlack } from "./slack.js";
import { config, now } from "./test-support.js";

const boundary = vi.hoisted(() => ({
  events: vi.fn(),
  read: { conversations: { info: vi.fn() }, files: { info: vi.fn() }, users: { list: vi.fn() } },
}));
vi.mock("./calendar-http.js", () => ({ fetchCalendarEvents: boundary.events }));
vi.mock("@openclaw/slack/api.js", () => ({
  resolveSlackAccount: () => ({ enabled: true, botToken: "synthetic" }),
  createSlackWebClient: () => boundary.read,
}));
function resolver(enabled = true, clock = () => now) {
  const signal = new AbortController().signal;
  const slack = createOncallSlack({ config, sourceConfig: {}, signal, assertCurrent() {} });
  return createCalendarRoster({
    config: { ...config, googleCalendar: { enabled } },
    signal,
    now: clock,
    assertCurrent() {},
    canvas: () => slack.roster(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.read.conversations.info.mockResolvedValue({
    channel: { properties: { canvas: { file_id: "F123456" } } },
  });
  const content = "P1: <@U765432>\nP2: <@W765432>";
  boundary.read.files.info.mockResolvedValue({
    file: { id: "F123456", content, size: Buffer.byteLength(content) },
  });
});

it("expires at query frontier even when lookup completion would extend beyond an unseen next shift", async () => {
  let clock = now;
  boundary.events.mockImplementation(async () => {
    clock += 20_000;
    return {
      events: [
        {
          summary: "Oncall P1",
          status: "confirmed",
          start: { dateTime: new Date(now - 60_000).toISOString() },
          end: { dateTime: new Date(now + 600_000).toISOString() },
          description: "Slack-User-ID: U123456",
        },
      ],
      queryEnd: now + 60_000,
      assertFresh() {},
    };
  });
  expect(await resolver(true, () => clock)()).toMatchObject({
    provider: "googleCalendar",
    validUntil: now + 60_000,
  });
  clock = now + 60_000;
  boundary.events.mockResolvedValue({ events: [], queryEnd: now + 60_000, assertFresh() {} });
  expect(await resolver(true, () => clock)()).toMatchObject({
    provider: "canvas",
    warning: "Calendar roster unavailable: incomplete_result; using current Canvas",
  });
});
it("defaults to fresh actual Canvas without Calendar lookup", async () => {
  expect(await resolver(false)()).toMatchObject({
    p1: "U765432",
    p2: "W765432",
    provider: "canvas",
  });
  expect(boundary.events).not.toHaveBeenCalled();
});
it("falls back to the entire fresh Canvas roster with separate warning and never stale slots", async () => {
  boundary.events.mockRejectedValue(new Error("upstream-secret-canary"));
  const read = resolver();
  const first = await read();
  expect(first).toMatchObject({
    p1: "U765432",
    p2: "W765432",
    provider: "canvas",
    warning: "Calendar roster unavailable: calendar_unavailable; using current Canvas",
  });
  expect(first.error).toBeUndefined();
  expect(JSON.stringify(first)).not.toContain("upstream-secret-canary");
  boundary.read.files.info.mockRejectedValueOnce(new Error("unavailable"));
  expect((await read()).p1).toBeUndefined();
  expect(boundary.read.files.info).toHaveBeenCalledTimes(2);
});
it("does not fall back under revoked authority", async () => {
  let current = true;
  boundary.events.mockImplementation(async () => {
    current = false;
    throw new Error("failure");
  });
  const canvas = vi.fn(async () => ({ p1: "U765432" }));
  const read = createCalendarRoster({
    config: { ...config, googleCalendar: { enabled: true } },
    signal: new AbortController().signal,
    now: () => now,
    assertCurrent() {
      if (!current) {
        throw new Error("retired");
      }
    },
    canvas,
  });
  await expect(read()).rejects.toThrow("retired");
  expect(canvas).not.toHaveBeenCalled();
});
