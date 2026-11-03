import {
  assertReportAmendmentAuthorized,
  type ReplyTurnDeliveryHost,
} from "openclaw/plugin-sdk/reply-turns";
import { getSlackWriteClient } from "../../client.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { editOwnThreadReply } from "./edit-own-thread-reply.js";
import { editRequest } from "./priority-card.js";

export function createReportEditor(
  setup: SlackDispatchSetup,
): ReplyTurnDeliveryHost["amendOwnReport"] {
  const { prepared } = setup;
  const { ctx, message, replyTurn } = prepared;
  const request = editRequest(
    message,
    ctx.botUserId,
    prepared.ctxPayload.CommandAuthorized === true,
  );
  if (!replyTurn || !request || !message.user) return undefined;
  const sender = message.user;
  return async (url, proposal, queuedReceipt, assertAdmission) => {
    const changes = structuredClone(proposal);
    assertReportAmendmentAuthorized(request.text, changes);
    const client = prepared.eventScope
      ? prepared.eventScope.writeClient
      : getSlackWriteClient(ctx.botToken, setup.slackClientOptions);
    if (!client?.token) throw new Error("Missing scoped Slack writer");
    return editOwnThreadReply({
      client,
      token: client.token,
      changes,
      queuedReceipt,
      sender,
      channel: message.channel,
      thread: request.threadId,
      requestId: request.messageId,
      team: prepared.eventScope?.teamId ?? ctx.teamId ?? "",
      botUser: ctx.botUserId,
      assertCurrent: () => {
        assertAdmission?.();
        replyTurn.assertCurrent();
      },
    })(url);
  };
}
