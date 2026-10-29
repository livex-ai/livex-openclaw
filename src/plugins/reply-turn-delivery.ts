import type { LivePreviewDeliveryResult } from "../channels/message/live.js";
import type {
  PreparedReplyTurn,
  ReplyTurnDelivery,
  ReplyTurnDeliveryHost,
} from "./reply-turn.types.js";

/** Only transport receipts can grant this plugin access to an accepted final message. */
export function createReplyTurnDelivery(
  turn: PreparedReplyTurn | undefined,
  host: ReplyTurnDeliveryHost,
): ReplyTurnDelivery {
  if (!turn) {
    return { deliver: host.deliver };
  }
  const acceptedFinalIds = new Set<string>();
  const remember = (result: LivePreviewDeliveryResult) => {
    if (!result.visibleReplySent || result.suppression || result.deliveryIntent) {
      return;
    }
    const id =
      result.receipt?.primaryPlatformMessageId ??
      result.receipt?.platformMessageIds[0] ??
      result.messageIds?.[0];
    if (id && !host.sourceMessageIds.includes(id)) {
      acceptedFinalIds.add(id);
    }
  };
  const assertAccepted = (messageId: string) => {
    turn.assertCurrent();
    if (!acceptedFinalIds.has(messageId) || host.sourceMessageIds.includes(messageId)) {
      throw new Error("Reply turn transport requires its own accepted final message");
    }
  };
  const delivery = turn.createDelivery({
    ...host,
    async resolvePermalink(messageId) {
      assertAccepted(messageId);
      const permalink = await host.resolvePermalink(messageId);
      assertAccepted(messageId);
      return permalink;
    },
    async annotateAcceptedFinal(input) {
      assertAccepted(input.messageId);
      await host.annotateAcceptedFinal(input);
    },
    async deliver(payload, info, preparedReport) {
      turn.assertCurrent();
      const result = await host.deliver(payload, info, preparedReport);
      if (info.kind !== "final") {
        return result;
      }
      if (!result.finalization) {
        remember(result);
        return result;
      }
      // Preserve the transport acknowledgement even if plugin bookkeeping is later revoked.
      // Finalization grants access only after the transport settles visible delivery.
      const finalization = result.finalization.then((settled) => {
        remember({ ...result, ...settled, finalization: undefined });
        return settled;
      });
      return { ...result, finalization };
    },
  });
  const correlation = delivery.queuedCorrelation;
  return {
    deliver: delivery.deliver,
    ...(correlation
      ? {
          queuedCorrelation: {
            ...correlation,
            async onReplyDelivered(payload, receipt) {
              if (receipt?.complete && receipt.kind === "final" && receipt.messageId) {
                remember({ visibleReplySent: true, messageIds: [receipt.messageId] });
              }
              await correlation.onReplyDelivered?.(payload, receipt);
            },
          },
        }
      : {}),
  };
}
