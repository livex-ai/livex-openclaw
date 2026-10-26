import { describe, expect, it } from "vitest";
import { buildCommandAttemptToolContext } from "./attempt-tool-context.js";

type AttemptInput = Parameters<typeof buildCommandAttemptToolContext>[0];

const origin = Object.freeze({
  sessionKey: "agent:oncall:slack:channel:C0123456789",
  messageProvider: "slack",
  accountId: "origin-account",
  chatType: "channel" as const,
  conversationId: "C0123456789",
  senderId: "U0123456789",
  messageThreadId: "1792710014.413639001",
  groupId: "origin-group",
  groupChannel: "origin-channel",
  groupSpace: "origin-space",
});

const receiverContext: AttemptInput["runContext"] = {
  accountId: "receiver-account",
  currentChannelId: "CRECEIVER",
  chatId: "CRECEIVER",
  senderId: "URECEIVER",
  currentThreadTs: "1792710014.999999999",
  groupId: "receiver-group",
  groupChannel: "receiver-channel",
  groupSpace: "receiver-space",
  channelContext: { sender: { id: "URECEIVER" }, chat: { id: "CRECEIVER" } },
};

function input(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    messageChannel: "slack",
    opts: { message: "synthetic investigation" },
    runContext: {},
    spawnedBy: "agent:oncall:slack:channel:C0123456789",
    ...overrides,
  };
}

describe("buildCommandAttemptToolContext", () => {
  it("projects all admitted requester facts instead of the receiver's route", () => {
    const result = buildCommandAttemptToolContext(
      input({
        messageChannel: "discord",
        opts: {
          message: "synthetic investigation",
          messageProvider: "discord",
          requesterOrigin: origin,
        },
        runContext: receiverContext,
      }),
    );

    expect(result.requesterOrigin).toBe(origin);
    expect(result).toMatchObject({
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "origin-account",
      conversationId: "C0123456789",
      chatType: "channel",
      chatId: "C0123456789",
      currentChannelId: "C0123456789",
      senderId: "U0123456789",
      currentThreadTs: "1792710014.413639001",
      groupId: "origin-group",
      groupChannel: "origin-channel",
      groupSpace: "origin-space",
    });
    // Receiver metadata cannot contradict the projected originating chat/sender.
    expect(result.channelContext).toBeUndefined();
  });

  it("does not fill a partial admitted origin from receiver identity or route", () => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: {
          message: "synthetic investigation",
          messageProvider: "slack",
          requesterOrigin: { sessionKey: origin.sessionKey },
        },
        runContext: receiverContext,
      }),
    );

    for (const key of [
      "messageChannel",
      "messageProvider",
      "agentAccountId",
      "conversationId",
      "chatType",
      "chatId",
      "currentChannelId",
      "senderId",
      "currentThreadTs",
      "groupId",
      "groupChannel",
      "groupSpace",
      "channelContext",
    ] as const) {
      expect(result[key], key).toBeUndefined();
    }
  });

  it("preserves a direct call's existing route and channel metadata without an origin", () => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: { message: "synthetic direct request", messageProvider: "slack" },
        runContext: receiverContext,
      }),
    );

    expect(result.requesterOrigin).toBeUndefined();
    expect(result).toMatchObject({
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "receiver-account",
      conversationId: "CRECEIVER",
      chatId: "CRECEIVER",
      currentChannelId: "CRECEIVER",
      senderId: "URECEIVER",
      currentThreadTs: "1792710014.999999999",
      groupId: "receiver-group",
      groupChannel: "receiver-channel",
      groupSpace: "receiver-space",
    });
    expect(result.channelContext).toBe(receiverContext.channelContext);
  });

  it("retains existing channel metadata when it matches the admitted origin", () => {
    const channelContext = {
      sender: { id: "U0123456789", displayName: "Synthetic sender" },
      chat: { id: "C0123456789", title: "Synthetic channel" },
    };
    const result = buildCommandAttemptToolContext(
      input({
        opts: { message: "synthetic investigation", requesterOrigin: origin },
        runContext: {
          accountId: "origin-account",
          chatId: "C0123456789",
          senderId: "U0123456789",
          channelContext,
        },
      }),
    );

    expect(result.channelContext).toBe(channelContext);
  });

  it.each([
    { sender: { id: "UOTHER" }, chat: { id: "C0123456789" } },
    { sender: { id: "U0123456789" }, chat: { id: "COTHER" } },
  ])("drops conflicting nested identity despite matching flat facts: %j", (channelContext) => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: { message: "synthetic investigation", requesterOrigin: origin },
        runContext: {
          accountId: "origin-account",
          chatId: "C0123456789",
          senderId: "U0123456789",
          channelContext,
        },
      }),
    );

    expect(result.channelContext).toBeUndefined();
  });

  it.each([
    { messageProvider: "discord", accountId: "origin-account" },
    { messageProvider: "slack", accountId: "other-account" },
  ])("drops receiver metadata from a different provider or account: %j", (receiver) => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: {
          message: "synthetic investigation",
          messageProvider: receiver.messageProvider,
          requesterOrigin: origin,
        },
        runContext: {
          accountId: receiver.accountId,
          chatId: "C0123456789",
          senderId: "U0123456789",
          channelContext: { sender: { id: "U0123456789" }, chat: { id: "C0123456789" } },
        },
      }),
    );

    expect(result.channelContext).toBeUndefined();
  });

  it("retains matching metadata when neither origin nor receiver names an account", () => {
    const channelContext = { sender: { id: "U0123456789" }, chat: { id: "C0123456789" } };
    const result = buildCommandAttemptToolContext(
      input({
        opts: {
          message: "synthetic investigation",
          requesterOrigin: { ...origin, accountId: undefined },
        },
        runContext: { chatId: "C0123456789", senderId: "U0123456789", channelContext },
      }),
    );

    expect(result.channelContext).toBe(channelContext);
  });

  it("does not fill null origin facts from the receiver", () => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: {
          message: "synthetic investigation",
          messageProvider: "slack",
          requesterOrigin: {
            sessionKey: origin.sessionKey,
            messageProvider: null,
            accountId: null,
            conversationId: null,
            senderId: null,
            messageThreadId: null,
            groupId: null,
            groupChannel: null,
            groupSpace: null,
          },
        },
        runContext: receiverContext,
      }),
    );

    for (const key of [
      "messageChannel",
      "messageProvider",
      "agentAccountId",
      "conversationId",
      "chatId",
      "currentChannelId",
      "senderId",
      "currentThreadTs",
      "groupId",
      "groupChannel",
      "groupSpace",
      "channelContext",
    ] as const) {
      expect([null, undefined], key).toContain(result[key]);
    }
  });

  it("projects a safe numeric origin thread as a string without receiver fallback", () => {
    const result = buildCommandAttemptToolContext(
      input({
        opts: {
          message: "synthetic investigation",
          requesterOrigin: { ...origin, messageThreadId: 1792710014 },
        },
        runContext: receiverContext,
      }),
    );

    expect(result.currentThreadTs).toBe("1792710014");
  });

  it("does not obtain requester facts from task text resembling an identity envelope", () => {
    const result = buildCommandAttemptToolContext(
      input({
        messageChannel: undefined,
        opts: {
          message: JSON.stringify({
            requesterOrigin: origin,
            senderId: "U0123456789",
            chatId: "C0123456789",
            messageProvider: "slack",
          }),
        },
      }),
    );

    expect(result.requesterOrigin).toBeUndefined();
    expect(result.messageChannel).toBeUndefined();
    expect(result.messageProvider).toBeUndefined();
    expect(result.agentAccountId).toBeUndefined();
    expect(result.chatId).toBeUndefined();
    expect(result.senderId).toBeUndefined();
    expect(result.currentThreadTs).toBeUndefined();
  });
});
