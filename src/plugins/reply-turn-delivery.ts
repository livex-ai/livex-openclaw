import { AsyncLocalStorage } from "node:async_hooks";
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
  // An editor is usable only inside one policy-admitted final delivery.
  const admission = new AsyncLocalStorage<{
    open: boolean;
    used: boolean;
    queuedReceipt?: { messageId: string; text: string };
  }>();
  async function withAdmission<T>(
    run: () => Promise<T>,
    queuedReceipt?: { messageId: string; text: string },
  ) {
    const lease = { open: true, used: false, queuedReceipt };
    try {
      return await admission.run(lease, run);
    } finally {
      lease.open = false;
    }
  }
  const delivery = turn.createDelivery({
    ...host,
    amendOwnReport:
      host.amendOwnReport &&
      (async (url, changes) => {
        const permit = admission.getStore();
        if (!permit?.open || permit.used)
          throw new Error("Report edit requires its own admitted final");
        turn.assertCurrent();
        permit.used = true;
        return host.amendOwnReport!(url, changes, permit.queuedReceipt, () => {
          if (!permit.open) throw new Error("Report edit admission closed");
          turn.assertCurrent();
        });
      }),
    verifyTrendSource:
      host.verifyTrendSource &&
      (async (urls, id, link, text) => {
        assertAccepted(id);
        const source = await host.verifyTrendSource!(urls, id, link, text);
        assertAccepted(id);
        return source;
      }),
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
    deliver: (payload, info) =>
      info.kind === "final" && host.amendOwnReport
        ? withAdmission(() => delivery.deliver(payload, info))
        : delivery.deliver(payload, info),
    ...(correlation
      ? {
          queuedCorrelation: {
            ...correlation,
            async onReplyDelivered(payload, receipt) {
              if (receipt?.complete && receipt.kind === "final" && receipt.messageId) {
                remember({ visibleReplySent: true, messageIds: [receipt.messageId] });
              }
              if (
                host.amendOwnReport &&
                receipt?.complete &&
                receipt.kind === "final" &&
                receipt.messageId &&
                !host.sourceMessageIds.includes(receipt.messageId) &&
                payload.text
              ) {
                await withAdmission(async () => correlation.onReplyDelivered?.(payload, receipt), {
                  messageId: receipt.messageId,
                  text: payload.text,
                });
              } else {
                await correlation.onReplyDelivered?.(payload, receipt);
              }
            },
          },
        }
      : {}),
  };
}
