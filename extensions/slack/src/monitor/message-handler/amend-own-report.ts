import {
  assertReportAmendmentAuthorized,
  type ReplyTurnDeliveryHost,
} from "openclaw/plugin-sdk/reply-turns";
import { getSlackWriteClient } from "../../client.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { editOwnThreadReply, prepareOwnThreadReply } from "./edit-own-thread-reply.js";
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
  if (!replyTurn || !request || !message.user) {
    return undefined;
  }
  const sender = message.user;
  return async (url, proposal, queuedReceipt, assertAdmission, linkedReports, ownerPluginId) => {
    const changes = structuredClone(proposal);
    assertReportAmendmentAuthorized(request.text, changes);
    const client = prepared.eventScope
      ? prepared.eventScope.writeClient
      : getSlackWriteClient(ctx.botToken, setup.slackClientOptions);
    if (!client?.token) {
      throw new Error("Missing scoped Slack writer");
    }
    const params = {
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
    };
    if (!linkedReports) {
      return editOwnThreadReply(params)(url);
    }
    if (
      ownerPluginId !== "livex-investigations" ||
      !changes.priority ||
      Object.keys(changes).length !== 1 ||
      linkedReports.length < 2 ||
      linkedReports.length > 100 ||
      linkedReports[0] !== url
    ) {
      throw new Error("Linked priority requires its verified investigation owner");
    }
    const targets = [...linkedReports];
    const origin = new URL(url).origin;
    const keys = targets.map((target) => new URL(target).origin + new URL(target).pathname);
    if (new Set(keys).size !== keys.length) {
      throw new Error("Duplicate linked report");
    }
    const preparedEdits: Array<Awaited<ReturnType<typeof prepareOwnThreadReply>>> = [];
    for (const target of targets) {
      const parsed = new URL(target);
      const thread = parsed.searchParams.get("thread_ts");
      if (
        !thread ||
        !/^\d{10}\.\d{6}$/.test(thread) ||
        parsed.origin !== origin ||
        (target === url && thread !== request.threadId)
      ) {
        throw new Error("Linked report root mismatch");
      }
      preparedEdits.push(
        await prepareOwnThreadReply({ ...params, thread, requestThread: request.threadId }, target),
      );
    }
    let initiatingMessage: string | undefined;
    for (const operation of preparedEdits) {
      const id = await operation.apply();
      initiatingMessage ??= id;
    }
    for (const operation of preparedEdits) {
      await operation.verify();
    }
    return initiatingMessage!;
  };
}
