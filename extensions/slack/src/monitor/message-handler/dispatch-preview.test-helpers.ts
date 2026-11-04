import type { PreparedSlackMessage } from "./types.js";

export function createPreparedMessageFactory(
  threadTs: string,
  postMessage: unknown,
  update: unknown,
) {
  return function createPreparedSlackMessage(params?: {
    cfg?: Record<string, unknown>;
    botUserId?: string;
    teamId?: string;
    accountConfig?: Record<string, unknown>;
    ctxPayload?: Record<string, unknown>;
    message?: Partial<PreparedSlackMessage["message"]>;
    replyToMode?: "off" | "first" | "all" | "batched";
    isDirectMessage?: boolean;
    route?: Partial<PreparedSlackMessage["route"]>;
    setSlackSessionStatus?: PreparedSlackMessage["ctx"]["setSlackSessionStatus"];
    typingReaction?: string;
    ackReactionMessageTs?: string;
    ackReactionPromise?: Promise<boolean> | null;
    relayIdentity?: { username?: string; iconUrl?: string; iconEmoji?: string };
    turnAdoptionLifecycle?: object;
    replyTurn?: Partial<NonNullable<PreparedSlackMessage["replyTurn"]>>;
    dispatchReplyFromConfig?: unknown;
    eventScope?: {
      teamId: string;
      client: Record<string, unknown>;
      writeClient?: Record<string, unknown>;
    };
  }) {
    const routeSessionKey = params?.route?.sessionKey ?? "agent:agent-1:slack:C123";
    const mainSessionKey = params?.route?.mainSessionKey ?? "main";
    const lastRoutePolicy =
      params?.route?.lastRoutePolicy ?? (routeSessionKey === mainSessionKey ? "main" : "session");
    const message = {
      channel: "C123",
      ts: "171234.111",
      thread_ts: threadTs,
      user: "U123",
      ...params?.message,
    };

    return {
      ctx: {
        cfg: params?.cfg ?? {},
        runtime: {},
        botToken: "xoxb-test",
        app: { client: { chat: { postMessage, update } } },
        teamId: params?.teamId ?? "T1",
        botUserId: params?.botUserId ?? "U_OPENCLAW",
        botId: "B_OPENCLAW",
        textLimit: 4000,
        typingReaction: params?.typingReaction ?? "",
        historyLimit: 0,
        allowFrom: [],
        dispatchReplyFromConfig: params?.dispatchReplyFromConfig,
        setSlackSessionStatus: params?.setSlackSessionStatus ?? (async () => true),
      },
      account: {
        accountId: "default",
        config: params?.accountConfig ?? {},
      },
      replyTurn: params?.replyTurn,
      relayIdentity: params?.relayIdentity,
      turnAdoptionLifecycle: params?.turnAdoptionLifecycle,
      eventScope: params?.eventScope,
      message,
      route: {
        agentId: "agent-1",
        accountId: "default",
        mainSessionKey,
        sessionKey: routeSessionKey,
        lastRoutePolicy,
        ...params?.route,
      },
      channelConfig: null,
      replyTarget: `channel:${message.channel}`,
      ctxPayload: {
        MessageThreadId: threadTs,
        ...params?.ctxPayload,
      },
      turn: {
        record: {},
      },
      replyToMode: params?.replyToMode ?? "all",
      isDirectMessage: params?.isDirectMessage ?? false,
      isRoomish: false,
      ackReactionValue: "eyes",
      ackReactionMessageTs: params?.ackReactionMessageTs,
      ackReactionPromise: params?.ackReactionPromise ?? null,
    } as never;
  };
}
