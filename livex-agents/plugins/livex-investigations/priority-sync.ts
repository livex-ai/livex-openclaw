import { z } from "zod";
import type { CatalogIssue } from "./schema.js";

export const priorityIntentSchema = z
  .object({
    messageId: z.string().regex(/^\d{10}\.\d{6}$/),
    senderId: z.string(),
    priority: z.enum(["Unknown", "Low", "Medium", "High", "Critical"]),
    targets: z.array(z.string()).min(2).max(100),
  })
  .strict();
export type PriorityIntent = z.infer<typeof priorityIntentSchema>;

/** Host-written report receipts, including canonical amendment references.
 * Trend replies and proposed links are not cards; prose never determines provenance. */
export function publishedReports(issue: CatalogIssue): string[] {
  const urls = new Map<string, string>();
  for (const entry of issue.whatWeDidLast) {
    if (entry.trend) {
      continue;
    }
    const parsed = new URL(entry.reportUrl);
    const key = parsed.origin + parsed.pathname;
    const previous = urls.get(key);
    if (
      previous &&
      new URL(previous).searchParams.get("thread_ts") !== parsed.searchParams.get("thread_ts")
    ) {
      throw new Error("Conflicting report roots");
    }
    urls.set(key, entry.reportUrl);
  }
  return [...urls.values()];
}
