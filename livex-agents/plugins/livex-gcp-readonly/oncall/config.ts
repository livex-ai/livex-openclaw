import { z } from "zod";
import { calendarPublicSchema } from "./calendar-config.js";

const slackId = (prefix: string) => z.string().regex(new RegExp(`^[${prefix}][A-Z0-9]+$`));
const limited = (maximum: number, fallback: number) =>
  z.number().int().min(1).max(maximum).default(fallback);

export const oncallSchema = z.strictObject({
  enabled: z.literal(true),
  accountId: z.string().trim().min(1).max(64),
  teamId: slackId("T"),
  channelId: slackId("CG"),
  publisherBotId: slackId("B"),
  publisherAppId: slackId("A").optional(),
  historicalSenderId: slackId("UW"),
  environment: z.string().trim().min(1).max(64),
  resourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
  resourceLabels: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().min(1).max(256))
    .refine((labels) => Object.keys(labels).length > 0 && Object.keys(labels).length <= 16),
  broadcastChannelId: slackId("CG").optional(),
  tickMs: limited(60_000, 60_000),
  maxRunMs: limited(600_000, 600_000),
  maxLogCalls: limited(10, 10),
  maxLogBytes: limited(307_200, 307_200),
  maxScanPages: limited(10, 10),
  maxReceipts: limited(2_000, 2_000),
  maxConcurrent: limited(2, 2),
  maxNudges: limited(3, 3),
  reminderMs: limited(600_000, 600_000),
  googleCalendar: calendarPublicSchema.optional(),
});

export type OncallConfig = z.infer<typeof oncallSchema>;

export function parseOncallConfig(value: unknown): OncallConfig | null {
  const enabled = z.object({ enabled: z.boolean().optional() }).safeParse(value);
  if (!enabled.success || enabled.data.enabled !== true) {
    return null;
  }
  return oncallSchema.parse(value);
}
