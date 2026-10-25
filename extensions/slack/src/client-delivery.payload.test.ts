// Slack tests cover final Web API payload handoff behavior.
import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

const payloadState = vi.hoisted(() => ({
  basePayload: {
    channel: "C123",
    text: "Deploy ✅",
    blocks: [{ type: "divider" }],
    metadata: { event_type: "deploy", event_payload: { status: "ready" } },
    thread_ts: "1712345678.123456",
    reply_broadcast: true as const,
    unfurl_links: false,
  },
}));

vi.mock("./post-message-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./post-message-payload.js")>();
  return {
    ...actual,
    buildSlackPostMessagePayload: vi.fn(() => payloadState.basePayload),
  };
});

const { postSlackMessageBestEffort } = await import("./client-delivery.js");

describe("postSlackMessageBestEffort", () => {
  it("passes the prepared payload directly when no identity is requested", async () => {
    const postMessage = vi.fn(async (_payload: unknown) => ({
      ok: true,
      ts: "1712345678.123456",
    }));
    const client = { chat: { postMessage } } as unknown as WebClient;

    await postSlackMessageBestEffort({ client, channelId: "C123", text: "Deploy ✅" });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toBe(payloadState.basePayload);
  });
});

it("encodes colored attachments without changing accessible text or the original thread", async () => {
  const { buildSlackPostMessagePayload } = await vi.importActual<
    typeof import("./post-message-payload.js")
  >("./post-message-payload.js");
  const attachments = [
    {
      color: "#E3B341",
      fallback: "Full report; recovery remains unverified.",
      blocks: [
        {
          type: "section" as const,
          text: { type: "plain_text" as const, text: "Next action: Check installation." },
        },
      ],
    },
  ];
  const input = {
    channelId: "C123",
    threadTs: "1712345678.123456",
    text: "Full report; recovery remains unverified.",
    attachments,
  };

  expect(buildSlackPostMessagePayload(input)).toEqual({
    channel: "C123",
    thread_ts: "1712345678.123456",
    text: input.text,
    attachments,
    unfurl_links: false,
  });
});
