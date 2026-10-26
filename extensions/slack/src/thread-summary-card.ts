import type {
  ContextBlock,
  HeaderBlock,
  MessageAttachment,
  MrkdwnElement,
  SectionBlock,
} from "@slack/types";
import type { SlackBlock } from "./blocks-render.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

export type SlackThreadSummaryCardOptions = {
  textLimit?: number;
  /**
   * Caller-owned, already verified active impact. Plain report text cannot
   * establish this fact; current automatic LiveX delivery does not supply it.
   */
  verifiedActiveCritical?: {
    basis: "existing-severity-policy" | "authorized-human-declaration";
    evidenceUrl: string;
  };
};

export type SlackThreadSummaryCard = {
  blocks: SlackBlock[];
  attachment: MessageAttachment;
  fallbackText: string;
};

type Disposition = "action" | "no-action" | "unclassified";
type SummarySectionBlock = SectionBlock & { text: MrkdwnElement };

const FIELD = /^\s*\*{0,2}([A-Za-z][A-Za-z /-]*?)\*{0,2}:\*{0,2}\s*(.*)$/;
const FIELD_NAMES = new Set([
  "title",
  "finding",
  "action",
  "next action",
  "impact",
  "uncertainty",
  "blocker",
  "blocked",
  "owner",
  "evidence",
  "investigation status",
  "checked window",
  "code revision",
  "revision",
  "markers verified",
]);
const SECTION_TEXT_LIMIT = 3_000;
const TITLE_TEXT_LIMIT = 150;
const COLORS = {
  critical: "#D92D20",
  action: "#D99A00",
  "no-action": "#2E8B57",
  unclassified: "#9CA3AF",
} as const;

function readDisposition(header: string): Disposition | null {
  const segments = header.split("·").map((part) =>
    part
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim(),
  );
  const matches = new Set<Disposition>();
  for (const segment of segments) {
    if (/^action required$/i.test(segment)) {
      matches.add("action");
    } else if (/^(?:reviewed\s*[—–-]\s*)?no new action$/i.test(segment)) {
      matches.add("no-action");
    } else if (/^unclassified$/i.test(segment)) {
      matches.add("unclassified");
    }
  }
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

function readStatuses(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/\binvestigation\s+(pending|running|partial|blocked|complete)\b/gi)].map(
        (match) => match[1]?.toLowerCase() ?? "",
      ),
    ),
  ];
}

function parseReport(text: string) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift() ?? "";
  const disposition = readDisposition(header);
  if (!disposition) {
    return null;
  }
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines) {
    const match = line.match(FIELD);
    if (match) {
      const name = (match[1] ?? "").toLowerCase().trim();
      if (!FIELD_NAMES.has(name) || fields.has(name)) {
        return null;
      }
      fields.set(name, (match[2] ?? "").trim());
      current = name;
    } else if (line.trim()) {
      if (!current) {
        return null;
      }
      fields.set(current, (fields.get(current) ?? "") + "\n" + line.trim());
    }
  }
  const finding = fields.get("finding");
  const action = fields.get("action") ?? fields.get("next action");
  if (
    !finding ||
    !action ||
    (fields.has("action") && fields.has("next action")) ||
    (fields.has("blocker") && fields.has("blocked"))
  ) {
    return null;
  }
  const headerStatuses = readStatuses(header);
  if (headerStatuses.length > 1) {
    return null;
  }
  const [headerStatus] = headerStatuses;
  const statusField = fields.get("investigation status");
  const explicitStatuses = statusField
    ? readStatuses("Investigation " + statusField.replace(/^investigation\s+/i, ""))
    : [];
  const [explicitStatus] = explicitStatuses;
  if (
    statusField &&
    (explicitStatuses.length !== 1 || (headerStatus && explicitStatus !== headerStatus))
  ) {
    return null;
  }
  return { fields, disposition, finding, action, status: explicitStatus ?? headerStatus };
}

function readHttpsDestination(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function evidenceLine(value: string | undefined, fields: Map<string, string>): string {
  const urls = new Set<string>();
  const metadata = (value ?? "").replace(
    /<(https?:\/\/[^<>\s|]+)(?:\|[^<>]*)?>|\[[^\]]*\]\((https?:\/\/[^()\s]+)\)|(https?:\/\/[^\s<>()|]+)/g,
    (
      _match,
      slackUrl: string | undefined,
      markdownUrl: string | undefined,
      bareUrl: string | undefined,
    ) => {
      const candidate = slackUrl ?? markdownUrl ?? bareUrl ?? "";
      urls.add(candidate);
      return "";
    },
  );
  const [candidate] = urls;
  const destination = urls.size === 1 && candidate ? readHttpsDestination(candidate) : undefined;
  const notes = [
    metadata.trim().replace(/^[\s·,;—–-]+|[\s·,;—–-]+$/g, ""),
    fields.get("checked window"),
    fields.get("code revision") ? "Inspected revision " + fields.get("code revision") : undefined,
    fields.get("revision") ? "Inspected revision " + fields.get("revision") : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ")
    .replace(/\b(today|yesterday|tonight|now)\b/gi, "[relative date unresolved]");
  const explicitDate = /\b\d{4}-\d{2}-\d{2}\b/.test(notes);
  const explicitZone =
    /\b(?:UTC|GMT|PDT|PST|EDT|EST|CDT|CST|MDT|MST)\b/.test(notes) ||
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^ ]*(?:Z|[+-]\d{2}:\d{2})/.test(notes);
  const parts = [
    destination
      ? "<" + escapeSlackMrkdwn(destination) + "|View evidence>"
      : "Verified evidence destination unavailable",
    !explicitDate || !explicitZone ? "Checked window/time zone not stated" : undefined,
    notes ? escapeSlackMrkdwn(notes) : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function section(label: string, value: string): SummarySectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: "*" + label + ":* " + escapeSlackMrkdwn(value), verbatim: true },
  };
}

/** Project explicit report facts; unsupported content keeps the complete original text path. */
export function buildSlackThreadSummaryCard(
  text: string,
  options: SlackThreadSummaryCardOptions = {},
): SlackThreadSummaryCard | null {
  const textLimit = Math.min(
    options.textLimit ?? SLACK_EDIT_TEXT_MAX_BYTES,
    SLACK_EDIT_TEXT_MAX_BYTES,
  );
  if (!Number.isFinite(textLimit) || Buffer.byteLength(text, "utf8") > textLimit) {
    return null;
  }
  const report = parseReport(text);
  if (!report) {
    return null;
  }
  const { fields, disposition, finding, action } = report;
  const qualifiedCritical =
    options.verifiedActiveCritical &&
    readHttpsDestination(options.verifiedActiveCritical.evidenceUrl) &&
    ["existing-severity-policy", "authorized-human-declaration"].includes(
      options.verifiedActiveCritical.basis,
    );
  const dispositionText = {
    action: "Action required",
    "no-action": "Reviewed—no new action",
    unclassified: "Unclassified",
  }[disposition];
  const emoji = qualifiedCritical
    ? "🔴"
    : { action: "⚠️", "no-action": "✅", unclassified: "❓" }[disposition];
  const title = fields.get("title") ?? "Investigation summary";
  if (title.length > TITLE_TEXT_LIMIT || title.includes("\n")) {
    return null;
  }
  const body: (HeaderBlock | ContextBlock | SummarySectionBlock)[] = [
    { type: "header", text: { type: "plain_text", text: title } },
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: emoji + " " + (qualifiedCritical ? "Critical · " : "") + dispositionText,
        },
      ],
    },
    section("Next action", action),
    section("Impact", fields.get("impact") ?? "Not separately established in this report."),
    section("Finding", finding),
  ];
  const uncertainty = fields.get("uncertainty");
  const blocker = fields.get("blocker") ?? fields.get("blocked");
  if (uncertainty || blocker) {
    body.push(
      section(
        uncertainty && blocker ? "Uncertainty / Blocker" : uncertainty ? "Uncertainty" : "Blocker",
        [uncertainty, blocker].filter(Boolean).join("\n"),
      ),
    );
  }
  body.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Evidence:* " + evidenceLine(fields.get("evidence"), fields),
      verbatim: true,
    },
  });
  if (
    body.some((block) => block.type !== "context" && block.text.text.length > SECTION_TEXT_LIMIT)
  ) {
    return null;
  }
  return {
    blocks: [{ type: "divider" }],
    attachment: {
      color: qualifiedCritical ? COLORS.critical : COLORS[disposition],
      blocks: body,
    },
    fallbackText: text,
  };
}
