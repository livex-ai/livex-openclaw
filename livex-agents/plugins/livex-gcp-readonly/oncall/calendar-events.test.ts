import { expect, it } from "vitest";
import { calendarDescriptionId, selectCalendarRoster } from "./calendar-events.js";
import { now } from "./test-support.js";

const iso = (value: number) => new Date(value).toISOString();
function event(role = "P1", changes: Record<string, unknown> = {}) {
  return {
    summary: `Oncall ${role}`,
    status: "confirmed",
    start: { dateTime: iso(now - 60_000) },
    end: { dateTime: iso(now + 300_000) },
    description: "Slack-User-ID: U123456",
    ...changes,
  };
}

it.each([
  "Slack-User-ID: U123456",
  "<p><b>Slack-User-ID:</b>&nbsp;U123456</p>",
  "notes<br />Slack-User-ID: U123456<div>notes</div>",
])("accepts only supported explicit identity formatting: %s", (description) => {
  expect(calendarDescriptionId(description)).toBe("U123456");
});
it.each([
  "Slack-User-ID: U123456\nSlack-User-ID: U123456",
  "<p class='hidden'>Slack-User-ID: U123456</p>",
  "<script>Slack-User-ID: U123456</script>",
  "<a href='U123456'>notes</a>",
  "Slack-User-ID: &#85;123456",
  "Slack-User-ID: U123<br>456",
  "Slack-User-ID: <@U123456>",
  "Slack-User-ID: U123456" + " ".repeat(4096),
])("rejects unsupported or ambiguous description: %s", (description) => {
  expect(() => calendarDescriptionId(description)).toThrow("invalid_roster");
});
it("requires P1, allows absent P2, and caps validity at exact query frontier", () => {
  expect(selectCalendarRoster([event()], now, now + 20_000)).toMatchObject({
    p1: "U123456",
    provider: "googleCalendar",
    validUntil: now + 20_000,
  });
  expect(() => selectCalendarRoster([event("P2")], now, now + 60_000)).toThrow("invalid_roster");
});
it("expires at observed next role transition and chooses new half-open assignment", () => {
  const next = event("P1", {
    start: { dateTime: iso(now + 10_000) },
    description: "Slack-User-ID: W765432",
  });
  const old = event("P1", { end: { dateTime: iso(now + 10_000) } });
  expect(selectCalendarRoster([old, next], now, now + 60_000).validUntil).toBe(now + 10_000);
  expect(selectCalendarRoster([old, next], now + 10_000, now + 60_000).p1).toBe("W765432");
});
it.each(
  [
    [event(), event()],
    [event("P1", { start: { date: "2026-11-07" } })],
    [event("P1", { start: { dateTime: iso(now - 60_000), date: "2026-11-07" } })],
    [event("P1", { endTimeUnspecified: true })],
    [event("P1", { start: { dateTime: "2026-11-07T10:00:00" } })],
    [event("P1", { start: { dateTime: "2026-02-30T10:00:00Z" } })],
    [event("P1", { description: "no binding" })],
  ].map((events) => ({ events })),
)("rejects ambiguous/malformed role set %#", ({ events }) => {
  expect(() => selectCalendarRoster(events, now, now + 60_000)).toThrow("invalid_roster");
});
it("ignores unrelated/nonconfirmed events and respects offset instants", () => {
  const items = [
    event("P1", { start: { dateTime: "2026-11-07T12:59:00+03:00" } }),
    event("P2", { status: "cancelled" }),
    event("P2", { status: "tentative" }),
    { summary: "Other" },
  ];
  expect(selectCalendarRoster(items, now, now + 60_000).p2).toBeUndefined();
  expect(() => selectCalendarRoster(items, now + 60_000, now + 60_000)).toThrow(
    "incomplete_result",
  );
});
