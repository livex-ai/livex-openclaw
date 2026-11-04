import { isDeepStrictEqual } from "node:util";
import type { MessageAttachment } from "@slack/types";
import type { Block, WebClient } from "@slack/web-api";
import type { ReportAmendment } from "openclaw/plugin-sdk/reply-turns";
import { didSlackReplyEditApply } from "./preview-finalize.js";
import { updateReportCard } from "./priority-card.js";

function matchesAckBlocks(blocks: unknown, text: string) {
  if (blocks === undefined || (Array.isArray(blocks) && blocks.length === 0)) {
    return true;
  }
  if (!Array.isArray(blocks) || blocks.length !== 1) {
    return false;
  }
  const { block_id: _id, ...block } = blocks[0] ?? {};
  // Slack may generate this exact rich-text representation for a plain reply.
  return isDeepStrictEqual(block, {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  });
}

type EditParams = {
  client: WebClient;
  token: string;
  channel: string;
  thread: string;
  requestId: string;
  changes: ReportAmendment;
  sender: string;
  queuedReceipt?: { messageId: string; text: string };
  requestThread?: string;
  team: string;
  botUser: string;
  assertCurrent: () => void;
};

export function editOwnThreadReply(params: EditParams): (permalink: string) => Promise<string> {
  return async (permalink) => (await prepareOwnThreadReply(params, permalink)).apply();
}

export async function prepareOwnThreadReply(params: EditParams, permalink: string) {
  const { client, token, channel, thread, requestId, assertCurrent } = params;
  const url = new URL(permalink);
  const parts = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !parts ||
    parts[1] !== channel ||
    (url.searchParams.has("thread_ts") && url.searchParams.get("thread_ts") !== thread)
  ) {
    throw new Error("Reply target scope mismatch");
  }
  const ts = parts[2] + "." + parts[3];
  if (ts === thread || ts >= requestId) {
    throw new Error("Expected an earlier thread reply");
  }
  assertCurrent();
  const auth = await client.auth.test({ token });
  if (
    !auth.ok ||
    !params.team ||
    auth.team_id !== params.team ||
    !params.botUser ||
    auth.user_id !== params.botUser ||
    !auth.bot_id
  ) {
    throw new Error("Reply editor identity mismatch");
  }
  const receipt = params.queuedReceipt;
  if (receipt) {
    const id = receipt.messageId;
    if (!/^\d{10}\.\d{6}$/.test(id) || id <= requestId) {
      throw new Error("Invalid queued acknowledgment");
    }
    const read = await client.conversations.replies({
      token,
      channel,
      ts: params.requestThread ?? thread,
      oldest: id,
      latest: id,
      inclusive: true,
      limit: 2,
    });
    const ack = read.messages?.find((m) => m.ts === id);
    if (
      !read.ok ||
      !ack ||
      ack.user !== auth.user_id ||
      ack.bot_id !== auth.bot_id ||
      ack.thread_ts !== (params.requestThread ?? thread) ||
      ack.text !== receipt.text ||
      !matchesAckBlocks(ack.blocks, receipt.text) ||
      ack.attachments?.length ||
      ack.files?.length
    ) {
      throw new Error("Queued acknowledgment does not match the bound thread");
    }
  }
  const link = await client.chat.getPermalink({ token, channel, message_ts: ts });
  if (
    !link.ok ||
    !link.permalink ||
    new URL(link.permalink).origin !== url.origin ||
    new URL(link.permalink).pathname !== url.pathname
  ) {
    throw new Error("Canonical report permalink mismatch");
  }
  const result = await client.conversations.replies({
    token,
    channel,
    ts: thread,
    oldest: ts,
    latest: ts,
    inclusive: true,
    limit: 2,
  });
  const message = structuredClone(result.messages?.find((m) => m.ts === ts));
  if (
    !result.ok ||
    !message ||
    message.thread_ts !== thread ||
    message.user !== auth.user_id ||
    message.bot_id !== auth.bot_id ||
    typeof message.text !== "string"
  ) {
    throw new Error("Expected own report in the bound thread");
  }
  const next = updateReportCard(
    { text: message.text, blocks: message.blocks ?? [], attachments: message.attachments ?? [] },
    params.changes,
    params.sender,
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
  return {
    verify: async () => {
      assertCurrent();
      if (!(await didSlackReplyEditApply(expected))) {
        throw new Error("Linked priority readback changed");
      }
      assertCurrent();
    },
    apply: async () => {
      assertCurrent();
      if (params.requestThread) {
        const fresh = await client.conversations.replies({
          token,
          channel,
          ts: thread,
          oldest: ts,
          latest: ts,
          inclusive: true,
          limit: 2,
        });
        const current = fresh.messages?.find((m) => m.ts === ts);
        if (
          !fresh.ok ||
          !current ||
          current.user !== auth.user_id ||
          current.bot_id !== auth.bot_id ||
          current.thread_ts !== thread
        ) {
          throw new Error("Linked report identity changed");
        }
        if (await didSlackReplyEditApply(expected, current)) {
          return ts;
        }
        if (
          !isDeepStrictEqual(
            [current.text, current.blocks, current.attachments],
            [message.text, message.blocks, message.attachments],
          )
        ) {
          throw new Error("Report changed after preflight");
        }
      }
      // Recover a prior confirmed Slack edit whose catalog commit was interrupted.
      if (await didSlackReplyEditApply(expected, message)) {
        assertCurrent();
        return ts;
      }
      // Slack can accept the edit even if the HTTP response is lost. Verify the exact
      // target after either outcome; never turn an uncertain edit into a new post.
      assertCurrent();
      try {
        const response = await client.chat.update({
          token,
          channel,
          ts,
          text: next.text,
          blocks,
          attachments,
        });
        if (!response.ok) {
          throw Object.assign(new Error("Slack rejected the edit"), {
            code: "slack_webapi_platform_error",
          });
        }
      } catch (error) {
        if ((error as { code?: string })?.code === "slack_webapi_platform_error") {
          throw error;
        }
        assertCurrent();
      }
      if (!(await didSlackReplyEditApply(expected))) {
        throw new Error("Edit not confirmed by Slack readback");
      }
      assertCurrent();
      return ts;
    },
  };
}
