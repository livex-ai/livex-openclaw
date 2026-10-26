import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import type {
  GetReplyOptions,
  ReplyDispatchRuntimeInfo,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import type { InvestigationTurn } from "./runtime.js";
import { commitInvestigations } from "./store.js";

export type InvestigationPublicationResult = {
  status: "recorded" | "skipped" | "failed";
  reason?: string;
};

/** Catalog publication follows confirmed transport settlement; model completion alone is insufficient. */
export function createInvestigationPublication(params: {
  turn: InvestigationTurn;
  resolvePermalink: (messageId: string) => Promise<string>;
}) {
  let recorded = false;
  return {
    async publish(input: {
      kind: "tool" | "block" | "final";
      text: string;
      complete: boolean;
      delivery: LivePreviewDeliveryResult;
    }): Promise<InvestigationPublicationResult> {
      if (recorded || input.kind !== "final" || !input.complete) {
        return { status: "skipped" };
      }
      try {
        params.turn.assertCurrent();
        const prepared = params.turn.matchFinal(input.text);
        if (!prepared) {
          return {
            status: "skipped",
            reason: "The final reply has no matching prepared investigation facts",
          };
        }
        const settled = input.delivery.finalization
          ? { ...input.delivery, ...(await input.delivery.finalization), finalization: undefined }
          : input.delivery;
        params.turn.assertCurrent();
        const messageId =
          settled.receipt?.primaryPlatformMessageId ??
          settled.receipt?.platformMessageIds[0] ??
          settled.messageIds?.[0];
        if (
          !settled.visibleReplySent ||
          settled.suppression ||
          settled.deliveryIntent ||
          !messageId
        ) {
          return { status: "skipped" };
        }
        const reportUrl = await params.resolvePermalink(messageId);
        params.turn.assertCurrent();
        const url = new URL(reportUrl);
        if (
          url.protocol !== "https:" ||
          !url.hostname.endsWith(".slack.com") ||
          !url.pathname.startsWith(`/archives/${params.turn.scope.channelId}/`)
        ) {
          return { status: "failed", reason: "Slack returned an invalid investigation permalink" };
        }
        const result = await commitInvestigations({
          filePath: params.turn.filePath,
          scope: params.turn.scope,
          updates: prepared.updates,
          reportUrl,
          now: new Date(),
          assertCurrent: params.turn.assertCurrent,
        });
        if (result.status === "committed" || result.status === "unchanged") {
          recorded = true;
          return { status: "recorded" };
        }
        return {
          status: "failed",
          reason: `Investigation catalog update ${result.status}: ${result.reason ?? "completed findings were not fully recorded"}`,
        };
      } catch {
        // The Slack reply is already accepted. A bookkeeping failure must not make delivery retry it.
        return {
          status: "failed",
          reason:
            "Investigation catalog publication failed; prior records were preserved where available",
        };
      }
    },
  };
}

/** Channel wiring stays in dispatch; this owner preserves catalog transport and bookkeeping policy. */
export function createInvestigationDelivery(params: {
  turn?: InvestigationTurn;
  sourceMessageIds: readonly (string | undefined)[];
  resolvePermalink: (messageId: string) => Promise<string>;
  annotateAcceptedFinal: (input: { messageId: string; text: string }) => Promise<void>;
  reportError: (message: string) => void;
  deliver: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => Promise<LivePreviewDeliveryResult>;
}) {
  const investigationTurn = params.turn;
  const investigationPublication = investigationTurn
    ? createInvestigationPublication({
        turn: investigationTurn,
        resolvePermalink: params.resolvePermalink,
      })
    : undefined;
  const addHistoryWarning = (text: string, warning: string) => {
    const sentence = `Investigation history: ${warning}`;
    return /^\*\*Uncertainty:\*\*/m.test(text)
      ? text.replace(/^(\*\*Uncertainty:\*\*[^\n]*)/m, `$1 ${sentence}`)
      : `${text}\n\n**Uncertainty:** ${sentence}`;
  };
  const recordInvestigationDelivery = async (
    payload: ReplyPayload,
    kind: "tool" | "block" | "final",
    result: LivePreviewDeliveryResult,
    complete: boolean,
    warnOnUnprepared = false,
  ) => {
    if (!investigationTurn || !investigationPublication || !payload.text) {
      return;
    }
    const publication = await investigationPublication.publish({
      kind,
      text: payload.text,
      delivery: result,
      complete,
    });
    if (publication.status !== "failed" && !(warnOnUnprepared && publication.reason)) {
      return;
    }
    params.reportError(publication.reason ?? "Investigation catalog publication failed");
    let settled = result;
    try {
      if (result.finalization) {
        settled = { ...result, ...(await result.finalization) };
      }
    } catch {
      return;
    }
    const messageId = settled.receipt?.primaryPlatformMessageId ?? settled.messageIds?.[0];
    if (
      !settled.visibleReplySent ||
      !messageId ||
      params.sourceMessageIds.includes(messageId) ||
      payload.mediaUrl ||
      payload.mediaUrls?.length ||
      payload.attachments?.length
    ) {
      return;
    }
    try {
      investigationTurn.assertCurrent();
      await params.annotateAcceptedFinal({
        messageId,
        text: addHistoryWarning(
          payload.text,
          publication.status === "failed"
            ? "the final was delivered, but saving the catalog failed; prior records are retained."
            : "no matching completed record was prepared; this result was not saved to the catalog.",
        ),
      });
    } catch {
      params.reportError(
        "Investigation catalog failure annotation was not confirmed; no additional message was sent",
      );
    }
  };
  const deliver = async (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ): Promise<LivePreviewDeliveryResult> => {
    let outgoing = payload;
    if (investigationTurn && info.kind === "final" && payload.text) {
      const preparedFacts = investigationTurn.matchFinal(payload.text);
      if (!preparedFacts) {
        outgoing = {
          ...payload,
          text: addHistoryWarning(
            payload.text,
            "no matching completed record was prepared; this result was not saved to the catalog.",
          ),
        };
      } else if (investigationTurn.snapshot.status !== "ready") {
        outgoing = {
          ...payload,
          text: addHistoryWarning(
            payload.text,
            `the prior-history lookup was ${investigationTurn.snapshot.status}; coverage is incomplete.`,
          ),
        };
      }
    }
    const result = await params.deliver(outgoing, info);
    await recordInvestigationDelivery(payload, info.kind, result, true);
    return result;
  };
  const queuedCorrelation:
    | NonNullable<GetReplyOptions["queuedDeliveryCorrelations"]>[number]
    | undefined = investigationTurn
    ? {
        begin() {},
        async onReplyDelivered(payload, receipt) {
          if (!receipt) {
            return;
          }
          await recordInvestigationDelivery(
            payload,
            receipt.kind,
            {
              visibleReplySent: receipt.complete,
              ...(receipt.messageId ? { messageIds: [receipt.messageId] } : {}),
            },
            receipt.complete,
            true,
          );
        },
      }
    : undefined;
  return { deliver, queuedCorrelation };
}
