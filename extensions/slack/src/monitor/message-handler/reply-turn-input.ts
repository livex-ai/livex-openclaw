import type { SlackMessageEvent } from "../../types.js";

export function slackReportEditRequest(
  message: SlackMessageEvent,
  botUser: string,
  authorized: boolean,
) {
  const prefix = `<@${botUser}>`;
  const text = message.text?.trim();
  if (
    !authorized ||
    !botUser ||
    !message.user ||
    message.bot_id ||
    ("app_id" in message && message.app_id) ||
    !message.thread_ts ||
    !message.ts ||
    !text?.startsWith(prefix)
  ) {
    return undefined;
  }
  const body = text.slice(prefix.length).trim();
  return body && body.length <= 2000
    ? { text: body, threadId: message.thread_ts, messageId: message.ts }
    : undefined;
}

export function slackReplyTurnQuery(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join("\n\n").slice(0, 2_000);
}
