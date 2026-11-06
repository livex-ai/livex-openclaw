import type { WebClient } from "@slack/web-api";
import { expect, it, vi } from "vitest";
import { createTrendSourceVerifier } from "./trend-source.js";
import type { PreparedSlackMessage } from "./types.js";

it.each([
  "valid",
  "other author",
  "other thread",
  "other answer",
  "changed blocks",
  "other workspace",
] as const)("requires both Slack replies to belong to this case thread: %s", async (mode) => {
  const root = "1793000000.000001",
    report = "1793000001.000001",
    answer = "1793000004.000001";
  const url = (ts: string) => "https://example.slack.com/archives/C1/p" + ts.replace(".", "");
  const replies = vi.fn(async ({ oldest }: { oldest: string }) => ({
    ok: true,
    messages: [
      {
        ts: oldest,
        thread_ts: oldest === report && mode === "other thread" ? "other" : root,
        bot_id: "B1",
        blocks:
          mode === "changed blocks" && oldest === answer
            ? [{ type: "section", text: { type: "mrkdwn", text: "something else" } }]
            : [],
        user: mode === "other author" ? "U2" : "U1",
        text: oldest === answer && mode === "other answer" ? "changed" : "verified text",
      },
    ],
  }));
  const verify = createTrendSourceVerifier(
    {
      message: { ts: "1793000003.000001", thread_ts: root, channel: "C1" },
      ctx: { botUserId: "U1" },
    } as PreparedSlackMessage,
    { conversations: { replies } } as unknown as WebClient,
  )!;
  const source = mode === "other workspace" ? url(report).replace("example", "other") : url(report);
  expect(await verify([source], answer, url(answer), "verified text")).toBe(
    mode === "valid" ? source : undefined,
  );
});
