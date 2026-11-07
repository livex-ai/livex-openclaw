import { z } from "zod";

export const CALENDAR_SECRET_PATHS = {
  clientSecret: "oncall.googleCalendar.oauth.clientSecret",
  refreshToken: "oncall.googleCalendar.oauth.refreshToken",
} as const;
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const CALENDAR_LIMITS = {
  timeoutMs: 30_000,
  queryMs: 60_000,
  pages: 10,
  events: 1_000,
  tokenBytes: 65_536,
  pageBytes: 262_144,
  totalBytes: 2_097_152,
  descriptionBytes: 4_096,
} as const;

// Parse only public orchestration values; host runtime owns all credential material.
export const calendarPublicSchema = z
  .object({
    enabled: z.boolean().default(false),
    calendarId: z.string().max(1_024).optional(),
    oauth: z.object({ clientId: z.string().max(1_024).optional() }).optional(),
  })
  .transform(({ enabled, calendarId, oauth }) => ({
    enabled,
    ...(calendarId === undefined ? {} : { calendarId }),
    ...(oauth?.clientId === undefined ? {} : { oauth: { clientId: oauth.clientId } }),
  }));
export type CalendarConfig = z.infer<typeof calendarPublicSchema>;
export type CalendarFailure =
  | "missing_credentials"
  | "token_rejected"
  | "calendar_unavailable"
  | "invalid_roster"
  | "incomplete_result"
  | "secret_changed";
export class CalendarUnavailable extends Error {
  constructor(readonly category: CalendarFailure) {
    super(`Calendar roster unavailable: ${category}`);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function publicGcpConfig(value: unknown) {
  const source = record(value);
  const oncall = record(source?.oncall);
  if (!source || !oncall) {
    return value;
  }
  return {
    ...source,
    oncall: { ...oncall, googleCalendar: calendarPublicSchema.parse(oncall.googleCalendar ?? {}) },
  };
}

export function publicGcpEntry(value: unknown) {
  const entry = record(value);
  return entry ? { ...entry, config: publicGcpConfig(entry.config) } : value;
}
