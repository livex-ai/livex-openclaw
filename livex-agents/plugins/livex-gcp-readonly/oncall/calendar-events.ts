import { z } from "zod";
import { CALENDAR_LIMITS, CalendarUnavailable } from "./calendar-config.js";
import { isSlackUserId } from "./roster.js";
import type { Roster } from "./types.js";

export function calendarDescriptionId(description: unknown): string {
  if (
    typeof description !== "string" ||
    Buffer.byteLength(description) > CALENDAR_LIMITS.descriptionBytes
  ) {
    throw new CalendarUnavailable("invalid_roster");
  }
  for (const [tag] of description.matchAll(/<[^>]*>/g)) {
    if (!/^<(?:\/?(?:p|div|b|strong)|br(?:\/| \/)?)>$/i.test(tag)) {
      throw new CalendarUnavailable("invalid_roster");
    }
  }
  const text = description
    .replace(/\r\n/g, "\n")
    .replace(/<\/?(?:p|div)>|<br(?:\/| \/)?>/gi, "\n")
    .replace(/<\/?(?:b|strong)>/gi, "")
    .replace(/&(?:nbsp|#160);/g, " ");
  if (/[<>]|&(?:#?[A-Za-z0-9]+);/.test(text)) {
    throw new CalendarUnavailable("invalid_roster");
  }
  return descriptionField(text);
}

function descriptionField(text: string) {
  const fields = text.split("\n").filter((line) => /^[\t ]*Slack-User-ID:/.test(line));
  const match =
    fields.length === 1
      ? /^[\t ]*Slack-User-ID:[\t ]+([UW][A-Z0-9]+)[\t ]*$/.exec(fields[0]!)
      : null;
  if (!match || !isSlackUserId(match[1]!)) {
    throw new CalendarUnavailable("invalid_roster");
  }
  return match[1]!;
}

const intervalSchema = z.object({
  start: z.object({ dateTime: z.iso.datetime({ offset: true }), date: z.never().optional() }),
  end: z.object({ dateTime: z.iso.datetime({ offset: true }), date: z.never().optional() }),
  endTimeUnspecified: z.literal(false).optional(),
  description: z.unknown().optional(),
});

function role(value: unknown): "p1" | "p2" | undefined {
  const header = z
    .object({ summary: z.unknown().optional(), status: z.unknown().optional() })
    .safeParse(value);
  if (!header.success) {
    throw new CalendarUnavailable("invalid_roster");
  }
  if (header.data.status !== "confirmed") {
    return undefined;
  }
  if (header.data.summary === "Oncall P1") {
    return "p1";
  }
  return header.data.summary === "Oncall P2" ? "p2" : undefined;
}

function interval(value: unknown) {
  const parsed = intervalSchema.safeParse(value);
  if (!parsed.success) {
    throw new CalendarUnavailable("invalid_roster");
  }
  const start = Date.parse(parsed.data.start.dateTime);
  const end = Date.parse(parsed.data.end.dateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new CalendarUnavailable("invalid_roster");
  }
  return { start, end, description: parsed.data.description };
}

export function selectCalendarRoster(events: unknown[], now: number, frontier: number): Roster {
  if (now >= frontier) {
    throw new CalendarUnavailable("incomplete_result");
  }
  const roster: Roster = { provider: "googleCalendar", validUntil: frontier };
  for (const value of events) {
    const slot = role(value);
    if (!slot) {
      continue;
    }
    const candidate = interval(value);
    if (candidate.end <= now) {
      continue;
    }
    if (candidate.start > now) {
      roster.validUntil = Math.min(roster.validUntil!, candidate.start);
      continue;
    }
    if (roster[slot]) {
      throw new CalendarUnavailable("invalid_roster");
    }
    roster[slot] = calendarDescriptionId(candidate.description);
    roster.validUntil = Math.min(roster.validUntil!, candidate.end);
  }
  if (!roster.p1) {
    throw new CalendarUnavailable("invalid_roster");
  }
  return roster;
}
