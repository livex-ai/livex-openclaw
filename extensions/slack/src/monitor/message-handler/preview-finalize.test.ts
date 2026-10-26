// Slack tests cover preview finalize plugin behavior.
import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const editSlackMessageMock = vi.fn();

vi.mock("../../actions.js", () => ({
  editSlackMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
  editSlackRenderedMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
}));

let finalizeSlackPreviewEdit: typeof import("./preview-finalize.js").finalizeSlackPreviewEdit;

function createClient(overrides?: {
  historyMessages?: Array<Record<string, unknown>>;
  replyMessages?: Array<Record<string, unknown>>;
}) {
  return {
    conversations: {
      history: vi.fn(async () => ({ messages: overrides?.historyMessages ?? [] })),
      replies: vi.fn(async () => ({ messages: overrides?.replyMessages ?? [] })),
    },
  } as unknown as WebClient;
}

describe("finalizeSlackPreviewEdit", () => {
  beforeAll(async () => {
    ({ finalizeSlackPreviewEdit } = await import("./preview-finalize.js"));
  });

  beforeEach(() => {
    editSlackMessageMock.mockReset();
  });

  it("does not accept matching text when the colored attachment did not update", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed after commit"));
    const attachments = [
      {
        color: "#E3B341",
        fallback: "Full report",
        blocks: [
          {
            type: "section" as const,
            text: { type: "plain_text" as const, text: "Next action: Check installation." },
          },
        ],
      },
    ];
    const client = createClient({
      replyMessages: [
        {
          ts: "171234.567",
          text: "Full report",
          attachments: [{ ...attachments[0], color: "#2EB67D" }],
        },
      ],
    });
    const input = {
      client,
      token: "xoxb-test",
      channelId: "C123",
      messageId: "171234.567",
      threadTs: "171234.000000",
      text: "Full report",
      attachments,
    };

    await expect(finalizeSlackPreviewEdit(input)).rejects.toThrow("socket closed after commit");
  });

  it("reconciles the same attachment after Slack assigns IDs and normalizes its hex color", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed after commit"));
    const attachments = [
      {
        color: "#E3B341",
        fallback: "Full report",
        blocks: [
          {
            type: "section" as const,
            text: { type: "plain_text" as const, text: "Next action: Check installation." },
          },
        ],
      },
    ];
    const client = createClient({
      replyMessages: [
        {
          ts: "171234.567",
          text: "Full report",
          attachments: [
            {
              ...attachments[0],
              id: 1,
              color: "e3b341",
              blocks: [{ ...attachments[0].blocks[0], block_id: "slack-generated" }],
            },
          ],
        },
      ],
    });
    const input = {
      client,
      token: "xoxb-test",
      channelId: "C123",
      messageId: "171234.567",
      threadTs: "171234.000000",
      text: "Full report",
      attachments,
    };

    await expect(finalizeSlackPreviewEdit(input)).resolves.toBeUndefined();
    expect(editSlackMessageMock.mock.calls[0]?.[3]).toMatchObject({ attachments });
    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: "171234.000000",
        oldest: "171234.567",
        latest: "171234.567",
        inclusive: true,
      }),
    );
  });

  it("recovers an applied edit beyond the first busy-thread readback page", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed after commit"));
    const messageId = "171234.000101";
    const threadMessages = Array.from({ length: 102 }, (_, index) => ({
      ts: `171234.${String(index).padStart(6, "0")}`,
      text: index === 101 ? "final answer" : `message ${String(index)}`,
    }));
    const client = createClient();
    (client.conversations.replies as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      ({
        oldest,
        latest,
        inclusive,
        limit,
      }: {
        oldest?: string;
        latest?: string;
        inclusive?: boolean;
        limit?: number;
      }) => ({
        messages: threadMessages
          .filter(
            (message) =>
              (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
              (!latest || message.ts < latest || (inclusive && message.ts === latest)),
          )
          .slice(0, limit),
      }),
    );

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId,
        threadTs: "171234.000000",
        text: "final answer",
      }),
    ).resolves.toBeUndefined();
  });

  it("rethrows when readback does not match the expected final text", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text: "partial draft" }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "final answer",
      }),
    ).rejects.toThrow("socket closed");
  });

  it("accepts native-data fallback blocks after an ambiguous retry response", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const blocks = [
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ] as const;
    const text = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    const fallbackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text, verbatim: true },
      },
    ];
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text, blocks: fallbackBlocks }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "",
        blocks: blocks as unknown as Parameters<typeof finalizeSlackPreviewEdit>[0]["blocks"],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts native-data text fallback without blocks after an ambiguous retry response", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const blocks = [
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ] as const;
    const text = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "",
        blocks: blocks as unknown as Parameters<typeof finalizeSlackPreviewEdit>[0]["blocks"],
      }),
    ).resolves.toBeUndefined();
  });
});
