import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReplyDispatchRuntimeInfo } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { LivePreviewDeliveryResult } from "../channels/message/live.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentReportProfile } from "./report-profile.types.js";

/** Authenticated channel facts and bounded context for one prepared reply turn. */
export type ReplyTurnInput = {
  config: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId: string;
  workspaceId: string;
  nativeChannelId: string;
  senderId: string;
  sessionKey: string;
  isDirectMessage: boolean;
  query: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
};

/** Transport operations are bound to this turn's accepted receipts by the host. */
export type ReplyTurnDeliveryHost = {
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
};

export type ReplyTurnDelivery = {
  deliver: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => Promise<LivePreviewDeliveryResult>;
  queuedCorrelation?: NonNullable<GetReplyOptions["queuedDeliveryCorrelations"]>[number];
};

/** One plugin-owned contribution, retaining the existing reply ownership contracts. */
export type PreparedReplyTurn = {
  context: string;
  toolBindings: NonNullable<MsgContext["GatewayRunToolBindings"]>;
  reportProfile?: AgentReportProfile;
  assertCurrent: () => void;
  lifecycle: (
    upstream?: GetReplyOptions["turnAdoptionLifecycle"],
  ) => NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>;
  releaseImmediate: () => void;
  createDelivery: (host: ReplyTurnDeliveryHost) => ReplyTurnDelivery;
};

export type ReplyTurnProvider = {
  id: string;
  agentIds: readonly string[];
  channels: readonly string[];
  prepare: (input: ReplyTurnInput) => Promise<PreparedReplyTurn | undefined>;
};
