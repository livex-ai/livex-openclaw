import { assertReportAmendmentAuthorized } from "openclaw/plugin-sdk/reply-turns";
import type { ReportAmendment, ReplyTurnInput } from "openclaw/plugin-sdk/reply-turns";
import { z } from "zod";
import { assertNoSensitiveContent, type CatalogSnapshot } from "./schema.js";

export type AmendmentRequest = NonNullable<ReplyTurnInput["amendmentRequest"]>;
export type StagedAmendment = {
  changes: ReportAmendment;
  finalText: string;
  snapshot: CatalogSnapshot;
};
const fields = z
  .object({
    priority: z.enum(["Unknown", "Low", "Medium", "High", "Critical"]).optional(),
    nextAction: z.string().trim().min(1).max(2000).optional(),
    acceptOwnership: z.literal(true).optional(),
  })
  .strict();

export function prepareAmendment(
  raw: unknown,
  request: AmendmentRequest | undefined,
  snapshot: CatalogSnapshot,
): StagedAmendment | { clarification: string } {
  const changes = fields.parse(raw);
  if (!request || snapshot.status !== "ready" || !Object.keys(changes).length)
    throw new Error("A scoped human request and readable case are required");
  assertNoSensitiveContent(changes);
  try {
    assertReportAmendmentAuthorized(request.text, changes);
  } catch {
    // Let the model interpret unfamiliar language. The human can attest the proposed
    // fields in a fresh direct reply without a pending intent or a new grammar rule.
    const fields = [
      ...(changes.priority ? ["set priority to " + changes.priority] : []),
      ...(changes.acceptOwnership ? ["assign this to me"] : []),
      ...(changes.nextAction ? ["set next action to " + changes.nextAction] : []),
    ].join("; ");
    assertReportAmendmentAuthorized(fields, changes);
    return {
      clarification:
        "Clarify the requested change. If these values are correct, mention the bot in this thread and say: " +
        fields,
    };
  }
  return {
    changes,
    finalText:
      "Requested report update: " +
      Object.entries(changes)
        .map(([key, v]) =>
          key === "acceptOwnership"
            ? "accept ownership"
            : key === "priority"
              ? "priority " + v
              : "new next action",
        )
        .join(", ") +
      ".",
    snapshot,
  };
}
