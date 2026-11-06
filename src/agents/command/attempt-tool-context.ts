import type { AgentAttemptParams } from "./attempt-execution.types.js";

/** Project admitted command facts into embedded and CLI tool construction. */
export function buildCommandAttemptToolContext(
  params: Pick<AgentAttemptParams, "messageChannel" | "opts" | "runContext" | "spawnedBy">,
) {
  const origin = params.opts.requesterOrigin;
  const receiver = params.runContext;
  const receiverProvider = params.opts.messageProvider ?? params.messageChannel;
  // An admitted origin is authoritative even when some of its facts are absent.
  const messageProvider = origin ? (origin.messageProvider ?? undefined) : receiverProvider;
  const accountId = origin ? (origin.accountId ?? undefined) : receiver.accountId;
  const chatId = origin ? (origin.conversationId ?? undefined) : receiver.chatId;
  const senderId = origin ? (origin.senderId ?? undefined) : receiver.senderId;
  const channelContext = receiver.channelContext;
  // Retain receiver metadata only for the same route/principal; never manufacture
  // channel admission or carry another receiver's nested identity into the child.
  const sameChannelContext =
    messageProvider &&
    messageProvider === receiverProvider &&
    accountId === receiver.accountId &&
    chatId &&
    chatId === receiver.chatId &&
    senderId &&
    senderId === receiver.senderId &&
    (channelContext?.sender?.id === undefined || channelContext.sender.id === senderId) &&
    (channelContext?.chat?.id === undefined || channelContext.chat.id === chatId);
  return {
    requesterOrigin: origin,
    operatorProfileId: params.opts.operatorAuthority?.profileId,
    conversationId: chatId,
    chatType: origin?.chatType,
    messageChannel: origin ? messageProvider : params.messageChannel,
    messageProvider,
    agentAccountId: accountId,
    groupId: origin ? (origin.groupId ?? undefined) : receiver.groupId,
    groupChannel: origin ? (origin.groupChannel ?? undefined) : receiver.groupChannel,
    groupSpace: origin ? (origin.groupSpace ?? undefined) : receiver.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: origin ? chatId : receiver.currentChannelId,
    chatId,
    channelContext: !origin || sameChannelContext ? channelContext : undefined,
    currentThreadTs: origin
      ? origin.messageThreadId == null
        ? undefined
        : String(origin.messageThreadId)
      : receiver.currentThreadTs,
    currentInboundAudio: receiver.currentInboundAudio,
    replyToMode: receiver.replyToMode,
    senderId,
    senderIsOwner: params.opts.senderIsOwner,
    gitContributorProfileId: params.opts.gitContributorProfileId,
    scheduledToolPolicy: params.opts.scheduledToolPolicy,
    pinnedWidgetAuthoring: params.opts.pinnedWidgetAuthoring,
  };
}
