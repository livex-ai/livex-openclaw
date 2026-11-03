import { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { getSlackWriteClient } from "../../client.js";
import { formatSlackError } from "../../errors.js";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { editOwnThreadReply } from "./edit-own-thread-reply.js";
import { explicitPriorityEdit } from "./priority-card.js";
import type { PreparedSlackMessage } from "./types.js";

export async function dispatchPriorityEdit(
  setup: SlackDispatchSetup,
  turnAdoptionLifecycle: PreparedSlackMessage["turnAdoptionLifecycle"],
) {
  const { prepared, cfg, sourceReplyDeliveryMode, runtime, replyPipeline } = setup;
  const { account, ctx, message, route } = prepared;
  const edit = prepared.replyTurn?.handleExplicitEdit;
  if (edit && prepared.replyTurn) {
    const assertCurrent = prepared.replyTurn.assertCurrent;
    const request = explicitPriorityEdit(
      message,
      ctx.botUserId,
      prepared.ctxPayload.CommandAuthorized === true,
    );
    if (!request) throw new Error("Unauthorized priority edit");
    const marker = `Update report priority to ${request.priority}.`;
    let admitted = false;
    let attempted = false;
    // Use normal inbound recording, deduplication and outbound policy. Only an
    // admitted final reaches the adapter; suppressed or transformed finals cannot edit.
    await dispatchChannelInboundTurn({
      cfg,
      channel: "slack",
      accountId: account.accountId,
      route,
      ctxPayload: prepared.ctxPayload,
      record: prepared.turn.record,
      dispatchReplyFromConfig: ctx.dispatchReplyFromConfig,
      botLoopProtection: resolveSlackBotLoopProtection(prepared),
      dispatcherOptions: { transformReplyPayload: replyPipeline.transformReplyPayload },
      replyOptions: { sourceReplyDeliveryMode, turnAdoptionLifecycle, suppressTyping: true },
      replyResolver: async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        admitted = true;
        return { text: marker };
      },
      delivery: {
        deliver: async (payload, info) => {
          if (
            !admitted ||
            attempted ||
            info.kind !== "final" ||
            payload.text !== marker ||
            Object.entries(payload).some(
              ([key, value]) => key !== "text" && value !== undefined && value !== false,
            )
          )
            return { visibleReplySent: false };
          attempted = true;
          const client = prepared.eventScope
            ? prepared.eventScope.writeClient
            : getSlackWriteClient(ctx.botToken, setup.slackClientOptions);
          if (!client?.token) throw new Error("No scoped Slack writer available");
          let confirmed: string | undefined;
          try {
            const hostEdit = editOwnThreadReply({
              client,
              token: client.token,
              priority: request.priority,
              channel: message.channel,
              thread: request.threadId,
              requestId: request.messageId,
              team: prepared.eventScope?.teamId ?? ctx.teamId ?? "",
              botUser: ctx.botUserId,
              assertCurrent,
            });
            await edit(async (url) => {
              confirmed = await hostEdit(url);
            });
          } catch (error) {
            runtime.error?.(
              danger("Slack report edit was not confirmed: " + formatSlackError(error)),
            );
            assertCurrent();
            await client.chat.postEphemeral({
              channel: message.channel,
              user: message.user!,
              thread_ts: request.threadId,
              text: "Could not confirm the requested edit and its case history. Check the original report before retrying.",
            });
          }
          return confirmed
            ? { visibleReplySent: true, messageIds: [confirmed] }
            : { visibleReplySent: false };
        },
      },
    });
    return true;
  }
  return false;
}
