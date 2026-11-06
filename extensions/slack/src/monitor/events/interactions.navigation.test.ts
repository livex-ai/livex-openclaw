import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, singleButtonBlocks } from "./interactions.test-support.js";

const ack = vi.fn().mockResolvedValue(undefined);
const respond = vi.fn().mockResolvedValue(undefined);
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<{ matched: boolean; handled: boolean; duplicate: boolean }>>(),
);
const pluginHandled = { matched: true, handled: true, duplicate: false };
let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>();
  return { ...actual, enqueueRoutedSystemEvent: enqueueSystemEventMock };
});
vi.mock("openclaw/plugin-sdk/heartbeat-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/heartbeat-runtime")>();
  return { ...actual, requestHeartbeat: requestHeartbeatMock };
});
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    createChannelInteractiveDispatcher: () => dispatchPluginInteractiveHandlerMock,
  };
});

function plainText(text: string) {
  return { type: "plain_text", text };
}
function actions(blockId: string, elements: Record<string, unknown>[]) {
  return { type: "actions", block_id: blockId, elements };
}
function section(text: string, blockId: string) {
  return { type: "section", block_id: blockId, text: { type: "mrkdwn", text } };
}
function setupInteractions() {
  const context = createContext();
  registerSlackInteractionEvents({ ctx: context.ctx as never });
  return context;
}
function actionBody(message: { text: string; blocks: unknown[] }) {
  return {
    user: { id: "U123" },
    channel: { id: "C1" },
    container: { channel_id: "C1", message_ts: "100.200" },
    message: { ts: "100.200", ...message },
  };
}

describe("Slack navigation button interactions", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueSystemEventMock.mockReturnValue(true);
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
  });

  it.each(["action", "actions block", "section accessory"])(
    "keeps generated URL buttons reusable when the URL is in the %s",
    async (urlSource) => {
      const { app, getHandler } = setupInteractions();
      const url = "https://example.com/logs";
      const clickedButton = {
        type: "button",
        action_id: "a4yC1",
        text: plainText("View Logs"),
      };
      const linkButton = { ...clickedButton, url };
      const blocks = [
        urlSource === "section accessory"
          ? { ...section("Alert", "log_links"), accessory: linkButton }
          : actions("log_links", [
              urlSource === "actions block" ? linkButton : clickedButton,
              { type: "button", action_id: "acknowledge", text: plainText("Acknowledge") },
            ]),
      ];
      for (let click = 0; click < 2; click++) {
        await getHandler()({
          ack,
          respond,
          body: actionBody({ text: "Alert", blocks }),
          action: {
            ...clickedButton,
            block_id: "log_links",
            ...(urlSource === "action" ? { url } : {}),
          },
        });
      }

      expect(ack).toHaveBeenCalledTimes(2);
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
      expect(app.client.chat.update).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "sibling button",
      blockId: "log_links",
      actionId: "view_logs",
      url: "https://example.com/logs",
    },
    {
      name: "same action in another block",
      blockId: "other_links",
      actionId: "acknowledge",
      url: "https://example.com/logs",
    },
    { name: "empty URL", blockId: "log_links", actionId: "acknowledge", url: " " },
  ])("does not suppress an ordinary action because of a $name", async (testCase) => {
    const { app, getHandler } = setupInteractions();
    const clickedButton = {
      type: "button",
      action_id: "acknowledge",
      text: plainText("Acknowledge"),
    };
    const linkButton = {
      type: "button",
      action_id: testCase.actionId,
      text: plainText("View Logs"),
      url: testCase.url,
    };
    const elements = [clickedButton];
    if (testCase.blockId === "log_links") {
      if (testCase.actionId === "acknowledge") {
        elements[0] = linkButton;
      } else {
        elements.push(linkButton);
      }
    }
    const blocks = [actions("log_links", elements)];
    if (testCase.blockId !== "log_links") {
      blocks.push(actions(testCase.blockId, [linkButton]));
    }
    await getHandler()({
      ack,
      body: actionBody({ text: "Alert", blocks }),
      action: { ...clickedButton, block_id: "log_links" },
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("lets a registered plugin handle a URL button before navigation fallback", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce(pluginHandled);
    const { app, getHandler } = setupInteractions();
    await getHandler()({
      ack,
      body: actionBody({ text: "Alert", blocks: singleButtonBlocks("log_links", "qa:view_logs") }),
      action: {
        type: "button",
        action_id: "qa:view_logs",
        block_id: "log_links",
        text: plainText("View Logs"),
        url: "https://example.com/logs",
      },
    });

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: "qa:view_logs" }),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  async function clickLinkButton(actionId: string, value?: string) {
    enqueueSystemEventMock.mockReturnValue(undefined);
    const { app, getHandler } = setupInteractions();

    await getHandler()({
      ack,
      body: actionBody({ text: "fallback", blocks: singleButtonBlocks("reply_actions", actionId) }),
      action: {
        type: "button",
        action_id: actionId,
        block_id: "reply_actions",
        url: "https://example.com/app",
        ...(value ? { value } : {}),
        text: { type: "plain_text", text: "Launch" },
      },
    });
    expect(ack).toHaveBeenCalled();
    return app;
  }

  it.each([
    { name: "current", actionId: "openclaw:reply_link:1:1", value: undefined },
    { name: "additional session", actionId: "openclaw:session_link:1", value: undefined },
    { name: "legacy", actionId: "openclaw:reply_button:1:1", value: "/approve req-1 allow-once" },
  ])("ignores $name Slack callbacks emitted for link-only reply buttons", async (testCase) => {
    const app = await clickLinkButton(testCase.actionId, testCase.value);

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("routes unrelated buttons that only share the session-link prefix", async () => {
    await clickLinkButton("openclaw:session_linked");

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalled();
  });
});
