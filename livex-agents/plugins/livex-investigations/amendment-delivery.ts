import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyTurnDeliveryHost } from "openclaw/plugin-sdk/reply-turns";
import type { ReportEditContent } from "openclaw/plugin-sdk/report-profiles";
import { assertReportAmendmentAuthorized } from "./amendment-authorization.js";
import type { InvestigationTurn } from "./runtime.js";
import { editCatalogReport } from "./store.js";

export function isAmendmentFinal(
  turn: InvestigationTurn | undefined,
  payload: ReplyPayload,
  kind: string,
) {
  return (
    kind === "final" &&
    Boolean(turn?.amendment) &&
    payload.text === turn?.amendment?.finalText &&
    Object.entries(payload).every(
      ([key, value]) => key === "text" || value === undefined || value === false,
    )
  );
}

export async function applyAmendment(
  turn: InvestigationTurn,
  edit: ReplyTurnDeliveryHost["amendOwnReport"],
) {
  const staged = turn.amendment;
  const request = turn.amendmentRequest;
  const amend = turn.reportProfile?.amend;
  if (!staged || !request || !edit || !amend) {
    throw new Error("No active reporter or amendment");
  }
  const changes = { ...staged.changes };
  assertReportAmendmentAuthorized(request.text, changes);
  const senderId = turn.scope.senderId;
  const project = (original: ReportEditContent) => amend(original, { ...changes }, senderId);
  let messageId: string | undefined;
  await editCatalogReport({
    filePath: turn.filePath,
    scope: turn.scope,
    threadId: request.threadId,
    messageId: request.messageId,
    changes,
    snapshot: staged.snapshot,
    assertCurrent: turn.assertCurrent,
    editLinked: async (linkedReports) => {
      messageId = await edit({ url: linkedReports[0]!, linkedReports, project });
    },
    edit: async (url) => {
      messageId = await edit({ url, project });
    },
  });
  return messageId;
}
