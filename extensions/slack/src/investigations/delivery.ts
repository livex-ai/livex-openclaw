import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import {
  copyReplyPayloadMetadata,
  isHostNoticePayload,
  isReplyPayloadTerminalContent,
} from "openclaw/plugin-sdk/reply-payload";
import { HEARTBEAT_TOKEN, isSilentReplyText } from "openclaw/plugin-sdk/reply-runtime";
import type {
  GetReplyOptions,
  ReplyDispatchRuntimeInfo,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { reportContext } from "./report-context.js";
import type { InvestigationTurn } from "./runtime.js";
import { commitInvestigations } from "./store.js";

function isInvestigationFinal(payload: ReplyPayload, kind: "tool" | "block" | "final"): boolean {
  return (
    kind === "final" &&
    Boolean(payload.text?.trim()) &&
    !isSilentReplyText(payload.text) &&
    payload.text?.trim().toUpperCase() !== HEARTBEAT_TOKEN &&
    isReplyPayloadTerminalContent(payload) &&
    !isHostNoticePayload(payload) &&
    !payload.mediaUrl &&
    !payload.mediaUrls?.length &&
    !payload.attachments?.length &&
    !payload.presentation &&
    !payload.interactive
  );
}

export type InvestigationPublicationResult =
  | { status: "recorded" | "skipped" | "failed"; reason?: string }
  | { status: "partial"; saved: number; skipped: number; reason: string };

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
        if (!prepared || (prepared.report && prepared.finalText !== input.text.trim())) {
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
        if (
          result.status === "partial" &&
          result.saved !== undefined &&
          result.skipped !== undefined
        ) {
          recorded = true;
          return {
            status: "partial",
            saved: result.saved,
            skipped: result.skipped,
            reason: `Investigation catalog partially saved: ${result.saved} saved, ${result.skipped} skipped`,
          };
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
  annotateAcceptedFinal: (input: {
    messageId: string;
    text: string;
    channelData?: ReplyPayload["channelData"];
  }) => Promise<void>;
  reportError: (message: string) => void;
  deliver: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
    preparedReport?: boolean,
  ) => Promise<LivePreviewDeliveryResult>;
}) {
  const investigationTurn = params.turn;
  const investigationPublication = investigationTurn
    ? createInvestigationPublication({
        turn: investigationTurn,
        resolvePermalink: params.resolvePermalink,
      })
    : undefined;
  const prepareFinal = (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    if (!investigationTurn || !isInvestigationFinal(payload, kind)) {
      return undefined;
    }
    const prepared = investigationTurn.matchFinal(payload.text!);
    const outgoing = prepared?.report
      ? copyReplyPayloadMetadata(payload, {
          ...payload,
          text: prepared.finalText,
          channelData: { ...payload.channelData, ...prepared.report.channelData },
        })
      : payload;
    return { payload: outgoing, prepared };
  };
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
    if (
      publication.status !== "failed" &&
      publication.status !== "partial" &&
      !(warnOnUnprepared && publication.reason)
    ) {
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
      let warning =
        "no matching completed record was prepared; this result was not saved to the catalog.";
      if (publication.status === "failed") {
        warning =
          "the final was delivered, but saving the catalog failed; prior records are retained.";
      } else if (publication.status === "partial") {
        warning = `saved ${publication.saved} finding${publication.saved === 1 ? "" : "s"}; skipped ${publication.skipped} because matching was uncertain or a catalog limit was reached.`;
      }
      const prepared = investigationTurn.matchFinal(payload.text);
      const report = prepared?.report
        ? investigationTurn.reportProfile?.appendNotice(
            prepared.report,
            warning,
            reportContext(prepared.updates, []),
          )
        : undefined;
      await params.annotateAcceptedFinal({
        messageId,
        text: report?.text ?? addHistoryWarning(payload.text, warning),
        ...(report ? { channelData: report.channelData } : {}),
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
    const projection = prepareFinal(payload, info.kind);
    let outgoing = projection?.payload ?? payload;
    if (projection && !projection.prepared) {
      outgoing = copyReplyPayloadMetadata(outgoing, {
        ...outgoing,
        text: addHistoryWarning(
          outgoing.text!,
          "no matching completed record was prepared; this result was not saved to the catalog.",
        ),
      });
    } else if (
      projection &&
      !projection.prepared?.report &&
      investigationTurn?.snapshot.status !== "ready"
    ) {
      outgoing = copyReplyPayloadMetadata(outgoing, {
        ...outgoing,
        text: addHistoryWarning(
          outgoing.text!,
          `the prior-history lookup was ${investigationTurn?.snapshot.status}; coverage is incomplete.`,
        ),
      });
    }
    const result = projection?.prepared?.report
      ? await params.deliver(outgoing, info, true)
      : await params.deliver(outgoing, info);
    if (projection) {
      await recordInvestigationDelivery(
        projection.prepared?.report ? outgoing : payload,
        info.kind,
        result,
        true,
      );
    }
    return result;
  };
  const queuedCorrelation:
    | NonNullable<GetReplyOptions["queuedDeliveryCorrelations"]>[number]
    | undefined = investigationTurn
    ? {
        begin() {},
        prepareReply(payload, context) {
          return prepareFinal(payload, context.kind)?.payload;
        },
        async onReplyDelivered(payload, receipt) {
          if (!receipt || !isInvestigationFinal(payload, receipt.kind)) {
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
