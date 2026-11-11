import type { WebClient } from "@slack/web-api";
import type { ReplyTurnDeliveryHost } from "openclaw/plugin-sdk/reply-turns";
import type { PreparedSlackMessage } from "./types.js";

// Slack can synthesize rich-text blocks for an otherwise plain message.
function matchesVisibleTrend(blocks: unknown, expected: string) {
  if (blocks === undefined || (Array.isArray(blocks) && blocks.length === 0)) return true;
  if (!Array.isArray(blocks) || blocks.length !== 1) return false;
  const { block_id: _id, ...block } = blocks[0] ?? {};
  if (block.type === "section")
    return (
      Object.keys(block).length === 2 &&
      block.text?.type === "mrkdwn" &&
      block.text.text === expected
    );
  if (
    block.type !== "rich_text" ||
    Object.keys(block).length !== 2 ||
    !Array.isArray(block.elements) ||
    block.elements.length !== 1
  )
    return false;
  const section = block.elements[0];
  if (
    section?.type !== "rich_text_section" ||
    Object.keys(section).length !== 2 ||
    !Array.isArray(section.elements)
  )
    return false;
  let visible = "";
  for (const part of section.elements) {
    if (part?.type === "text" && typeof part.text === "string" && Object.keys(part).length === 2)
      visible += part.text;
    else if (
      part?.type === "link" &&
      typeof part.text === "string" &&
      typeof part.url === "string" &&
      Object.keys(part).length === 3
    )
      visible += "<" + part.url + "|" + part.text + ">";
    else return false;
  }
  return visible === expected;
}

/** Verify both the accepted answer and a previously published case report in this thread.
 * Older chat.getPermalink results often omit thread_ts. Never infer membership from the channel. */
export function createTrendSourceVerifier(
  prepared: PreparedSlackMessage,
  client: WebClient,
): ReplyTurnDeliveryHost["verifyTrendSource"] {
  const { message, ctx } = prepared;
  const root = message.thread_ts;
  const requestId = message.ts;
  if (!requestId || !root || !ctx.botUserId) return undefined;
  const ownReply = async (ts: string) => {
    prepared.replyTurn?.assertCurrent();
    const result = await client.conversations.replies({
      channel: message.channel,
      ts: root,
      oldest: ts,
      latest: ts,
      inclusive: true,
      limit: 2,
    });
    prepared.replyTurn?.assertCurrent();
    return result.ok
      ? result.messages?.find(
          (m) => m.ts === ts && m.thread_ts === root && m.user === ctx.botUserId && m.bot_id,
        )
      : undefined;
  };
  return async (reportUrls, acceptedId, answerLink, finalText) => {
    const answerUrl = new URL(answerLink);
    if (
      !/^\d{10}\.\d{6}$/.test(acceptedId) ||
      acceptedId <= requestId ||
      answerUrl.pathname !== `/archives/${message.channel}/p${acceptedId.replace(".", "")}`
    )
      return undefined;
    const answer = await ownReply(acceptedId);
    if (
      !answer ||
      !matchesVisibleTrend(answer.blocks, finalText) ||
      answer.attachments?.length ||
      answer.files?.length ||
      typeof answer.text !== "string" ||
      answer.text.replaceAll("&amp;", "&") !== finalText.replaceAll("&amp;", "&")
    )
      return undefined;
    const candidates = reportUrls
      .map((link) => new URL(link))
      .filter(
        (url) =>
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.origin === answerUrl.origin &&
          (!url.searchParams.has("thread_ts") || url.searchParams.get("thread_ts") === root),
      );
    for (const url of candidates
      .reverse()
      .sort(
        (a, b) => Number(b.searchParams.has("thread_ts")) - Number(a.searchParams.has("thread_ts")),
      )
      .slice(0, 8)) {
      const parts = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
      if (parts?.[1] !== message.channel) continue;
      const ts = parts[2] + "." + parts[3];
      if (ts < requestId && ts !== root && (await ownReply(ts))) return url.href;
    }
    return undefined;
  };
}

export function createReportPermalinkResolver(
  prepared: PreparedSlackMessage,
  slackClient: WebClient,
): ReplyTurnDeliveryHost["resolvePermalink"] {
  const { message } = prepared;
  return async (messageId) => {
    prepared.replyTurn?.assertCurrent();
    const response = await slackClient.chat.getPermalink({
      channel: message.channel,
      message_ts: messageId,
    });
    prepared.replyTurn?.assertCurrent();
    if (!response.ok || !response.permalink) {
      throw new Error("Slack reply permalink unavailable");
    }
    return response.permalink;
  };
}
