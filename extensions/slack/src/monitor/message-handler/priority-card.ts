import type { ReportAmendment } from "openclaw/plugin-sdk/reply-turns";
import type { SlackMessageEvent } from "../../types.js";
export type ReplyTurnEditContent = { text: string; blocks: unknown[]; attachments: unknown[] };

export function editRequest(message: SlackMessageEvent, botUser: string, authorized: boolean) {
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
  )
    return undefined;
  const body = text.slice(prefix.length).trim();
  return body && body.length <= 2000
    ? { text: body, threadId: message.thread_ts, messageId: message.ts }
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unrecognized report card");
  return value as Record<string, unknown>;
}

function section(value: unknown, prefix: string) {
  const block = object(value);
  const text = object(block.text);
  if (
    block.type !== "section" ||
    text.type !== "mrkdwn" ||
    typeof text.text !== "string" ||
    !text.text.startsWith(prefix)
  ) {
    throw new Error("Unrecognized report section");
  }
  return text.text;
}

/** Only alter the priority display and its color. Keep the accepted report as the source of truth. */
export function updateReportCard(
  original: ReplyTurnEditContent,
  changes: ReportAmendment,
  sender: string,
): ReplyTurnEditContent {
  const result = structuredClone(original);
  if (result.blocks.length !== 1 || result.attachments.length !== 1)
    throw new Error("Expected a single compact report");
  section(result.blocks[0], "*Title:* ");
  const attachment = object(result.attachments[0]);
  const blocks = attachment.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 4)
    throw new Error("Expected compact report details");
  // Slack assigns fresh IDs on readback. Send only the rendered card content.
  delete attachment.id;
  for (const block of [...result.blocks, ...blocks]) {
    delete object(block).block_id;
  }
  const previous = section(blocks[0], "*Priority:* ");
  const parsed =
    /^\*Priority:\* (Unknown|Low|Medium|High|Critical)( · (?:Known issue|Blocked|Resolved))?$/.exec(
      previous,
    );
  if (!parsed) throw new Error("Unknown priority display");
  const action = section(blocks[1], "*Next action:* ");
  const priority = changes.priority ?? parsed[1];
  let newAction = action;
  if (changes.nextAction || changes.acceptOwnership) {
    const parts = /^(\*Next action:\* )(.+) · Owner: (.+)$/u.exec(action);
    if (!parts || action.includes(" · Owners: ") || action.split(" · Owner: ").length !== 2)
      throw new Error("Cannot amend ambiguous ownership");
    const escaped = changes.nextAction
      ?.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    newAction =
      "*Next action:* " +
      (escaped ?? parts[2]!) +
      " · Owner: " +
      (changes.acceptOwnership ? sender : parts[3]);
    if (newAction.length > 3000) throw new Error("Next action exceeds Slack section limit");
    object(object(blocks[1]).text).text = newAction;
  }
  section(blocks[2], "*Summary:* ");
  section(blocks[3], "*Evidence:* ");
  const next = `*Priority:* ${priority}${parsed[2] ?? ""}`;
  object(object(blocks[0]).text).text = next;
  // Slack may collapse the top-level fallback's newlines to spaces. Locate the
  // priority immediately before Next action; never touch a quotation in evidence.
  const actionLine = action;
  const updateFallback = (text: string) => {
    if (text === section(result.blocks[0], "*Title:* ")) return text;
    const action = text.indexOf("*Next action:*");
    const end = text.slice(0, action).trimEnd().length;
    const start = end - previous.length;
    if (
      !text.startsWith("*Title:* ") ||
      action < 0 ||
      start < 1 ||
      !/\s/.test(text.charAt(start - 1)) ||
      text.slice(start, end) !== previous
    ) {
      throw new Error("Unrecognized report fallback");
    }
    if (!text.startsWith(actionLine, action)) throw new Error("Unrecognized action fallback");
    const fallback =
      text.slice(0, start) +
      next +
      text.slice(end, action) +
      newAction +
      text.slice(action + actionLine.length);
    if (Buffer.byteLength(fallback) > 4000) throw new Error("Edited report exceeds fallback limit");
    return fallback;
  };
  result.text = updateFallback(result.text);
  if (typeof attachment.fallback === "string")
    attachment.fallback = updateFallback(attachment.fallback);
  if (changes.priority)
    attachment.color =
      parsed[2] === " · Resolved"
        ? "#2E8B57"
        : priority === "Critical" || priority === "High"
          ? "#D92D20"
          : priority === "Medium"
            ? "#D99A00"
            : "#9CA3AF";
  return result;
}

export function slackReplyTurnQuery(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join("\n\n").slice(0, 2_000);
}
