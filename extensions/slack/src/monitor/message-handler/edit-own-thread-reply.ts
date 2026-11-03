import type { MessageAttachment } from "@slack/types";
import type { Block, WebClient } from "@slack/web-api";
import { didSlackReplyEditApply } from "./preview-finalize.js";
import { updatePriority, type Priority } from "./priority-card.js";

export function editOwnThreadReply(params: {
  client: WebClient;
  token: string;
  channel: string;
  thread: string;
  requestId: string;
  priority: Priority;
  team: string;
  botUser: string;
  assertCurrent: () => void;
}): (permalink: string) => Promise<string> {
  return async (permalink) => {
    const { client, token, channel, thread, requestId, assertCurrent } = params;
    const url = new URL(permalink);
    const parts = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      !parts ||
      parts[1] !== channel ||
      (url.searchParams.has("thread_ts") && url.searchParams.get("thread_ts") !== thread)
    )
      throw new Error("Reply target scope mismatch");
    const ts = parts[2] + "." + parts[3];
    if (ts === thread || ts >= requestId) throw new Error("Expected an earlier thread reply");
    assertCurrent();
    const auth = await client.auth.test({ token });
    if (
      !auth.ok ||
      !params.team ||
      auth.team_id !== params.team ||
      !params.botUser ||
      auth.user_id !== params.botUser ||
      !auth.bot_id
    )
      throw new Error("Reply editor identity mismatch");
    const link = await client.chat.getPermalink({ token, channel, message_ts: ts });
    if (
      !link.ok ||
      !link.permalink ||
      new URL(link.permalink).origin !== url.origin ||
      new URL(link.permalink).pathname !== url.pathname
    )
      throw new Error("Canonical report permalink mismatch");
    const result = await client.conversations.replies({
      token,
      channel,
      ts: thread,
      oldest: ts,
      latest: ts,
      inclusive: true,
      limit: 2,
    });
    const message = result.messages?.find((m) => m.ts === ts);
    if (
      !result.ok ||
      !message ||
      message.thread_ts !== thread ||
      message.user !== auth.user_id ||
      message.bot_id !== auth.bot_id ||
      typeof message.text !== "string"
    )
      throw new Error("Expected own report in the bound thread");
    const next = updatePriority(
      { text: message.text, blocks: message.blocks ?? [], attachments: message.attachments ?? [] },
      params.priority,
    );
    const blocks = next.blocks as Block[];
    const attachments = next.attachments as MessageAttachment[];
    const expected = {
      client,
      token,
      channelId: channel,
      threadTs: thread,
      messageId: ts,
      text: next.text,
      blocks,
      attachments,
    };
    assertCurrent();
    // Slack can accept the edit even if the HTTP response is lost. Verify the exact
    // target after either outcome; never turn an uncertain edit into a new post.
    try {
      const response = await client.chat.update({
        token,
        channel,
        ts,
        text: next.text,
        blocks,
        attachments,
      });
      if (!response.ok)
        throw Object.assign(new Error("Slack rejected the edit"), {
          code: "slack_webapi_platform_error",
        });
    } catch (error) {
      if ((error as { code?: string })?.code === "slack_webapi_platform_error") throw error;
      assertCurrent();
    }
    if (!(await didSlackReplyEditApply(expected)))
      throw new Error("Edit not confirmed by Slack readback");
    assertCurrent();
    return ts;
  };
}
