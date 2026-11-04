import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
  SLACK_SESSION_LINK_ACTION_ID,
} from "../../reply-action-ids.js";
import type { SlackActionSummary } from "./modal-input-summary.js";

type SlackNavigationAction = {
  actionId: string;
  blockId?: string;
  typedAction: Record<string, unknown>;
  actionSummary: Pick<SlackActionSummary, "actionType">;
  typedBody: { message?: { blocks?: unknown[] } };
};

export function isSlackReplyActionId(actionId: string): boolean {
  return (
    actionId === SLACK_REPLY_BUTTON_ACTION_ID ||
    actionId === SLACK_REPLY_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_REPLY_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_REPLY_SELECT_ACTION_ID}:`)
  );
}

export function isSlackReplyLinkAction(parsed: SlackNavigationAction): boolean {
  if (parsed.actionId.replace(/:\d+$/u, "") === SLACK_SESSION_LINK_ACTION_ID) {
    return true;
  }
  if (
    parsed.actionId === SLACK_REPLY_LINK_ACTION_ID ||
    parsed.actionId.startsWith(`${SLACK_REPLY_LINK_ACTION_ID}:`)
  ) {
    return true;
  }
  const legacyUrl = normalizeOptionalString(parsed.typedAction.url);
  return Boolean(legacyUrl && isSlackReplyActionId(parsed.actionId));
}

export function isSlackNavigationButton(parsed: SlackNavigationAction): boolean {
  if (parsed.actionSummary.actionType !== "button") {
    return false;
  }
  if (normalizeOptionalString(parsed.typedAction.url)) {
    return true;
  }
  if (!parsed.blockId) {
    return false;
  }
  return (parsed.typedBody.message?.blocks ?? []).some((candidate) => {
    const block = asOptionalRecord(candidate);
    if (!block || block.block_id !== parsed.blockId) {
      return false;
    }
    const elements =
      block.type === "actions" && Array.isArray(block.elements)
        ? block.elements
        : block.type === "section"
          ? [block.accessory]
          : [];
    return elements.some((elementCandidate) => {
      const element = asOptionalRecord(elementCandidate);
      return (
        element?.type === "button" &&
        element.action_id === parsed.actionId &&
        Boolean(normalizeOptionalString(element.url))
      );
    });
  });
}
