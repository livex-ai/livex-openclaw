import type { ReplyTurnDeliveryHost } from "openclaw/plugin-sdk/reply-turns";
import { getSlackWriteClient } from "../../client.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { editOwnThreadReply, prepareOwnThreadReply } from "./edit-own-thread-reply.js";
import { slackReportEditRequest } from "./reply-turn-input.js";

export function createReportEditor(
  setup: SlackDispatchSetup,
): ReplyTurnDeliveryHost["amendOwnReport"] {
  const { prepared } = setup;
  const { ctx, message, replyTurn } = prepared;
  const request = slackReportEditRequest(
    message,
    ctx.botUserId,
    prepared.ctxPayload.CommandAuthorized === true,
  );
  if (!replyTurn || !request) {
    return undefined;
  }
  return async ({ url, linkedReports, project }, queuedReceipt, assertAdmission) => {
    const client = prepared.eventScope
      ? prepared.eventScope.writeClient
      : getSlackWriteClient(ctx.botToken, setup.slackClientOptions);
    if (!client?.token) {
      throw new Error("Missing scoped Slack writer");
    }
    const params = {
      client,
      token: client.token,
      project,
      queuedReceipt,
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
    if (linkedReports.length < 2 || linkedReports.length > 100 || linkedReports[0] !== url) {
      throw new Error("Invalid linked report targets");
    }
    const targets = [...linkedReports];
    const parsedTargets = targets.map((target) => new URL(target));
    const origin = parsedTargets[0]!.origin;
    const keys = parsedTargets.map((target) => target.origin + target.pathname);
    if (new Set(keys).size !== keys.length) {
      throw new Error("Duplicate linked report");
    }
    const preparedEdits: Array<Awaited<ReturnType<typeof prepareOwnThreadReply>>> = [];
    for (const [index, parsed] of parsedTargets.entries()) {
      const target = targets[index]!;
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
    params.assertCurrent();
    return initiatingMessage!;
  };
}
