import type { ReportAmendment, ReportEditContent } from "openclaw/plugin-sdk/report-profiles";
import {
  compactReportColor,
  COMPACT_REPORT_FIELDS as fields,
  escapeSlackMrkdwn,
  SLACK_EDIT_TEXT_MAX_BYTES,
  SLACK_SECTION_TEXT_LIMIT,
} from "./style.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unrecognized report card");
  }
  return value as Record<string, unknown>;
}

function section(value: unknown, prefix: string) {
  const block = object(value);
  const element = object(block.text);
  if (
    block.type !== "section" ||
    element.type !== "mrkdwn" ||
    typeof element.text !== "string" ||
    !element.text.startsWith(prefix)
  ) {
    throw new Error("Unrecognized report section");
  }
  return { element, text: element.text };
}

function amendAction(action: string, changes: ReportAmendment, senderId: string): string {
  if (!changes.nextAction && !changes.acceptOwnership) {
    return action;
  }
  const parts = /^(.+) · Owner: (.+)$/u.exec(action.slice(fields.action.length));
  if (!parts || action.includes(" · Owners: ") || action.split(" · Owner: ").length !== 2) {
    throw new Error("Cannot amend ambiguous ownership");
  }
  const next = changes.nextAction ? escapeSlackMrkdwn(changes.nextAction) : parts[1];
  const owner = changes.acceptOwnership ? senderId : parts[2];
  const amended = fields.action + next + " · Owner: " + owner;
  if (amended.length > SLACK_SECTION_TEXT_LIMIT) {
    throw new Error("Next action exceeds Slack section limit");
  }
  return amended;
}

function matchFallbackField(text: string, field: string): string | undefined {
  if (text.startsWith(field)) {
    return field;
  }
  // Slack can flatten whitespace in fallback while retaining the original block text.
  const collapsed = field.replace(/\s+/gu, " ");
  if (text.startsWith(collapsed)) {
    return collapsed;
  }
  return undefined;
}

function nextFieldStart(text: string, offset: number): number {
  return offset + (/^\s+/u.exec(text.slice(offset))?.[0].length ?? 0);
}

function locateEditableFields(
  text: string,
  priorityStart: number,
  priority: string,
  action: string,
) {
  if (!text.startsWith(priority, priorityStart)) {
    return undefined;
  }
  const priorityEnd = priorityStart + priority.length;
  const actionStart = nextFieldStart(text, priorityEnd);
  if (actionStart === priorityEnd) {
    return undefined;
  }
  const matchedAction = matchFallbackField(text.slice(actionStart), action);
  if (!matchedAction) {
    return undefined;
  }
  const actionEnd = actionStart + matchedAction.length;
  if (actionEnd < text.length && !/\s/u.test(text.charAt(actionEnd))) {
    return undefined;
  }
  return { priorityStart, priorityEnd, actionStart, actionEnd, matchedAction };
}

const unicodeEmoji = new RegExp("\\p{RGI_Emoji}", "gv");

function normalizeFallbackTitle(title: string): string {
  // Slack can wrap bare URLs and convert emoji to shortcodes in retrieved text.
  // Compare those slots only. Keep the original fallback bytes for the update.
  return title
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s|]+)(?:\|\1)?>/giu, "$1")
    .replace(/:[a-z0-9_+-]+:(?::skin-tone-[2-6]:)?/giu, "\u0000")
    .replace(unicodeEmoji, "\u0000")
    .replace(/\s+/gu, " ");
}

function locateAfterNormalizedTitle(text: string, title: string, priority: string, action: string) {
  const expectedTitle = normalizeFallbackTitle(title);
  for (
    let start = text.indexOf(priority, fields.title.length);
    start !== -1;
    start = text.indexOf(priority, start + priority.length)
  ) {
    if (
      /\s/u.test(text.charAt(start - 1)) &&
      normalizeFallbackTitle(text.slice(0, start).trimEnd()) === expectedTitle
    ) {
      return locateEditableFields(text, start, priority, action);
    }
  }
  return undefined;
}

function amendFallback(
  text: string,
  title: string,
  [priority, action]: readonly [string, string],
  [nextPriority, nextAction]: readonly [string, string],
): string {
  const matchedTitle = matchFallbackField(text, title);
  if (
    text === matchedTitle ||
    (!matchedTitle && normalizeFallbackTitle(text) === normalizeFallbackTitle(title))
  ) {
    return text;
  }
  // Anchor the verified priority/action pair after the full title when possible.
  // If Slack changed the title, verify the whole normalized prefix before editing.
  const priorityStart = matchedTitle ? nextFieldStart(text, matchedTitle.length) : 0;
  const located = matchedTitle
    ? priorityStart > matchedTitle.length &&
      locateEditableFields(text, priorityStart, priority, action)
    : locateAfterNormalizedTitle(text, title, priority, action);
  if (!located) {
    throw new Error("Unrecognized report fallback");
  }
  const amended =
    text.slice(0, located.priorityStart) +
    nextPriority +
    text.slice(located.priorityEnd, located.actionStart) +
    (nextAction === action ? located.matchedAction : nextAction) +
    text.slice(located.actionEnd);
  if (Buffer.byteLength(amended) > SLACK_EDIT_TEXT_MAX_BYTES) {
    throw new Error("Edited report exceeds fallback limit");
  }
  return amended;
}

function parsePriority(text: string) {
  const parsed = /^(Unknown|Low|Medium|High|Critical)( · (?:Known issue|Blocked|Resolved))?$/u.exec(
    text.slice(fields.priority.length),
  );
  if (!parsed) {
    throw new Error("Unknown priority display");
  }
  return { label: parsed[1], badge: parsed[2] ?? "" };
}

export function amendCompactReport(
  original: ReportEditContent,
  changes: ReportAmendment,
  senderId: string,
): ReportEditContent {
  const result = structuredClone(original);
  if (result.blocks.length !== 1 || result.attachments.length !== 1) {
    throw new Error("Expected a single compact report");
  }
  const title = section(result.blocks[0], fields.title).text;
  const attachment = object(result.attachments[0]);
  const blocks = attachment.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 4) {
    throw new Error("Expected compact report details");
  }
  const priority = section(blocks[0], fields.priority);
  const { label, badge } = parsePriority(priority.text);
  const action = section(blocks[1], fields.action);
  section(blocks[2], fields.summary);
  section(blocks[3], fields.evidence);
  const editableFields = [priority.text, action.text] as const;
  const nextPriority = fields.priority + (changes.priority ?? label) + badge;
  const nextAction = amendAction(action.text, changes, senderId);
  const replacements = [nextPriority, nextAction] as const;
  result.text = amendFallback(result.text, title, editableFields, replacements);
  if (typeof attachment.fallback === "string") {
    attachment.fallback = amendFallback(attachment.fallback, title, editableFields, replacements);
  }
  priority.element.text = nextPriority;
  action.element.text = nextAction;
  if (changes.priority) {
    attachment.color = compactReportColor(changes.priority, badge === " · Resolved");
  }
  // These static cards have no interactive IDs. Slack adds its own on readback.
  delete attachment.id;
  for (const block of [...result.blocks, ...blocks]) {
    delete object(block).block_id;
  }
  return result;
}
