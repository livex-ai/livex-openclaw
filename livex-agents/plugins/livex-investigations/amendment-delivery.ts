import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyTurnDeliveryHost } from "openclaw/plugin-sdk/reply-turns";
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
  if (!staged || !request || !edit) throw new Error("No active reporter or amendment");
  let messageId: string | undefined;
  await editCatalogReport({
    filePath: turn.filePath,
    scope: turn.scope,
    threadId: request.threadId,
    messageId: request.messageId,
    changes: staged.changes,
    snapshot: staged.snapshot,
    assertCurrent: turn.assertCurrent,
    edit: async (url) => {
      messageId = await edit(url, staged.changes);
    },
  });
  return messageId;
}
