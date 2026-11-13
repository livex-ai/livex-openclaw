import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const SUMMARY_MARKER = "LIVEX_ALERT_SUMMARY_V1";
const MARKED_LINE = new RegExp(`(?:^|\\n)[ \\t]*${SUMMARY_MARKER}[ \\t]*(?=\\r?\\n|$)`, "u");
const MAX_EVIDENCE_URL = 1600;
// The shipped evidence tool only produces Logs Explorer links on this host. The
// model writes the URL, so anything else (including lookalikes) is dropped.
const EVIDENCE_HOSTS = ["console.cloud.google.com"];
// `agent:debugger:slack:channel:<id>:thread:<ts>`, or with the team-qualified peer
// `channel:team:<team>:channel:<id>` that Slack workspace routing produces.
const DEBUGGER_SLACK_THREAD =
  /^agent:debugger:slack:channel:(?:team:[a-z0-9%._-]+:channel:)?[cg][a-z0-9]+:thread:\d+\.\d+$/u;
const FULL_EVIDENCE_HINT = "Mention this bot in the thread for full evidence.";
const INVALID_SUMMARY = `Could not format the investigation summary. ${FULL_EVIDENCE_HINT}`;
const PRIORITY_LABELS = new Map([
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["unknown", "Unknown"],
]);
// Stock Slack outbound cannot send legacy attachment colour bars, so priority
// colour is a leading emoji. Low and Unknown share the neutral marker.
const PRIORITY_MARKERS = new Map([
  ["critical", "\u{1F534}"],
  ["high", "\u{1F534}"],
  ["medium", "\u{1F7E1}"],
  ["low", "\u26AA"],
  ["unknown", "\u26AA"],
]);
const RESOLVED_MARKER = "\u{1F7E2}";
const REQUIRED_KEYS = [
  "priority",
  "provisional",
  "impact",
  "nextAction",
  "owner",
  "checkedWindow",
  "evidenceUrl",
];
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, "resolved"]);

function isBoundedLine(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function readEvidenceLink(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > MAX_EVIDENCE_URL ||
    !value.startsWith("https://") ||
    /[\s\p{Cc}<>|\\]/u.test(value)
  ) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const escapedUrl = url.href.replaceAll("&", "&amp;");
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      escapedUrl.length <= MAX_EVIDENCE_URL
    ) {
      // A well-formed link to any other host or port is dropped, not fatal: the
      // card still posts without it.
      if (!EVIDENCE_HOSTS.includes(url.hostname) || url.port !== "") {
        return null;
      }
      return `<${escapedUrl}|View evidence>`;
    }
  } catch {
    // An invalid evidence link invalidates the marked summary.
  }
  return undefined;
}

function readSummary(text: string) {
  // Read only the compact JSON line. Evidence belongs to the native assistant
  // transcript and must never be copied into the replacement Slack payload.
  const envelope = /^\S+\r?\n([^\r\n]{1,4096})\r?\n\r?\n(?=\s*\S)/u.exec(text);
  const json = envelope?.[1];
  if (!json) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const fields = value as Record<string, unknown>;
  const { priority, provisional, impact, nextAction, owner, checkedWindow, evidenceUrl, resolved } =
    fields;
  const priorityLabel = typeof priority === "string" ? PRIORITY_LABELS.get(priority) : undefined;
  const link = readEvidenceLink(evidenceUrl);
  if (
    !Object.keys(fields).every((key) => ALLOWED_KEYS.has(key)) ||
    !REQUIRED_KEYS.every((key) => key in fields) ||
    !priorityLabel ||
    typeof provisional !== "boolean" ||
    (resolved !== undefined && typeof resolved !== "boolean") ||
    !isBoundedLine(impact, 240) ||
    !isBoundedLine(nextAction, 120) ||
    !isBoundedLine(owner, 50) ||
    !isBoundedLine(checkedWindow, 64) ||
    link === undefined
  ) {
    return undefined;
  }

  const priorityText =
    provisional && priority !== "unknown" ? `${priorityLabel} (provisional)` : priorityLabel;
  const headline =
    resolved === true
      ? `${RESOLVED_MARKER} Resolved \u00B7 was ${priorityText}`
      : `${PRIORITY_MARKERS.get(priority as string)} Priority: ${priorityText}`;
  return {
    headline,
    impact,
    nextAction,
    owner,
    checkedWindow,
    evidenceLink: link,
  };
}

function plainText(text: string) {
  return { type: "plain_text", text };
}

function section(text: string) {
  return { type: "section", text: plainText(text) };
}

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  register(api) {
    api.on("reply_payload_sending", ({ kind, channel, sessionKey, payload }) => {
      if (
        kind !== "final" ||
        channel !== "slack" ||
        !sessionKey ||
        !DEBUGGER_SLACK_THREAD.test(sessionKey) ||
        payload.isReasoning ||
        payload.isCommentary ||
        payload.isStatusNotice
      ) {
        return;
      }
      const text = payload.text?.trimStart();
      if (!text || !MARKED_LINE.test(text)) {
        return;
      }

      // A misplaced marker still identifies an envelope. Fail closed instead
      // of passing the JSON and retained evidence through as an ordinary reply.
      const hasCanonicalMarker = text.split(/\r?\n/u, 1)[0] === SUMMARY_MARKER;

      const { replyToId, replyToTag, replyToCurrent } = payload;
      const route = { replyToId, replyToTag, replyToCurrent };
      const summary = hasCanonicalMarker ? readSummary(text) : undefined;
      if (!summary) {
        return { payload: { ...route, text: INVALID_SUMMARY } };
      }

      const evidenceLink = summary.evidenceLink
        ? [
            {
              type: "mrkdwn",
              text: summary.evidenceLink,
              verbatim: true,
            },
          ]
        : [];
      return {
        payload: {
          ...route,
          channelData: {
            slack: {
              blocks: [
                { type: "header", text: plainText(summary.headline) },
                section(`Impact: ${summary.impact}`),
                section(`Next action: ${summary.nextAction}\nOwner: ${summary.owner}`),
                section(`Evidence: ${summary.checkedWindow}`),
                { type: "context", elements: [...evidenceLink, plainText(FULL_EVIDENCE_HINT)] },
              ],
            },
          },
        },
      };
    });
  },
});
