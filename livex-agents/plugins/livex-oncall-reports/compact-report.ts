import type { SectionBlock } from "@slack/types";
import { z } from "zod";
import type { SlackThreadSummaryCard } from "./legacy-report.js";
import {
  assertNoSensitiveContent,
  type ReportFinding as FindingComparison,
  type ReportInvestigation as CompletedInvestigation,
} from "./report-context.js";
import { escapeSlackMrkdwn, SLACK_EDIT_TEXT_MAX_BYTES } from "./style.js";

export type CompactReport = {
  title: string;
  priority: "unknown" | "low" | "medium" | "high" | "critical";
  summary: string;
  nextAction: string;
  evidence: {
    links: { url: string; label?: string }[];
    checkedWindow?: string;
    note?: string;
  };
  badge?: {
    kind: "known-issue" | "blocked" | "resolved";
    evidenceUrl?: string;
  };
};

export type PreparedCompactReport = {
  form: CompactReport;
  text: string;
  card: SlackThreadSummaryCard;
};

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const compactReportSchema = z
  .object({
    title: boundedText(150),
    priority: z.enum(["unknown", "low", "medium", "high", "critical"]),
    summary: boundedText(3_000),
    nextAction: boundedText(2_000),
    evidence: z
      .object({
        links: z
          .array(
            z
              .object({
                url: boundedText(2_048),
                label: boundedText(120).optional(),
              })
              .strict(),
          )
          .max(30),
        checkedWindow: boundedText(512).optional(),
        note: boundedText(2_000).optional(),
      })
      .strict(),
    badge: z
      .object({
        kind: z.enum(["known-issue", "blocked", "resolved"]),
        evidenceUrl: boundedText(2_048).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Prepared state includes canonical links, URL normalization and host notices added after
// model input validation. Keep its structure without reapplying the model-only caps.
const preparedCompactReportSchema: z.ZodType<CompactReport> = compactReportSchema.extend({
  evidence: compactReportSchema.shape.evidence.extend({
    links: z.array(
      compactReportSchema.shape.evidence.shape.links.element.extend({ url: z.string() }),
    ),
    note: z.string().optional(),
  }),
  badge: compactReportSchema.shape.badge
    .unwrap()
    .extend({ evidenceUrl: z.string().optional() })
    .optional(),
});

export function readPreparedCompactReport(value: unknown): CompactReport {
  return preparedCompactReportSchema.parse(value);
}

export const compactReportParameters = z.toJSONSchema(compactReportSchema, { target: "draft-7" });

function httpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // A fixed boundary error must not echo an untrusted URL or its credentials.
  }
  throw new Error("Compact report evidence requires an HTTPS URL without credentials.");
}

function citedUrls(updates: CompletedInvestigation[], findings: FindingComparison[]): Set<string> {
  return new Set(
    [
      ...updates.flatMap((update) => [
        ...update.evidenceUrls,
        ...update.prs,
        ...update.slackThreads,
        ...update.jiraTickets,
        ...(update.facts.owner ? [update.facts.owner.evidenceUrl] : []),
      ]),
      ...findings.flatMap((finding) =>
        finding.canonicalThreadUrl ? [finding.canonicalThreadUrl] : [],
      ),
    ].map(httpsUrl),
  );
}

function allKnown(findings: FindingComparison[]): boolean {
  return (
    findings.length > 0 &&
    findings.every(
      (finding) =>
        (finding.kind === "known-persistence" || finding.kind === "changed") &&
        finding.canonicalThreadUrl,
    )
  );
}

function deriveLegacyForm(
  updates: CompletedInvestigation[],
  findings: FindingComparison[],
): CompactReport {
  const multiple = updates.length > 1;
  const summary = updates
    .map((update) => {
      const facts = [
        update.facts.finding.trim() || "Finding unknown",
        update.facts.impact.trim() || "Impact unknown",
      ];
      return `${multiple ? `${update.task}: ` : ""}${[...new Set(facts)].join(" ")}`;
    })
    .join("\n");
  const nextAction = updates
    .map(
      (update) =>
        `${multiple ? `${update.task}: ` : ""}${update.facts.nextAction.trim() || "Next action unknown"}`,
    )
    .join("; ");
  const evidence = [...new Set(updates.flatMap((update) => update.evidenceUrls))];
  const notes = [
    ...new Set(
      updates.flatMap((update) =>
        update.facts.evidence?.trim() ? [update.facts.evidence.trim()] : [],
      ),
    ),
  ];
  return {
    title: multiple
      ? `${updates.length} investigation findings`
      : updates[0]!.task.trim() || "Investigation summary",
    priority: "unknown",
    summary,
    nextAction,
    evidence: {
      links: evidence.map((url) => ({ url })),
      ...(notes.length ? { note: notes.join(" · ") } : {}),
    },
    ...(allKnown(findings) ? { badge: { kind: "known-issue" as const } } : {}),
  };
}

/** Explicit unresolved statements cannot support an optional whole-report resolution badge. */
function hasAssertedRecovery(value: string | undefined): boolean {
  const recovery = value?.trim();
  if (!recovery) {
    return false;
  }
  const unresolved = [
    /\b(?:unknown|uncertain|unconfirmed|unverified|unrecovered)\b/i,
    /\b(?:not|never)\s+(?:(?:yet|been)\s+)?(?:recovered|confirmed|verified|established|healthy|resolved|restored)\b/i,
    /\bstill\s+(?:failing|unhealthy|broken)\b/i,
    /\bno\s+(?:(?:confirmed|verified)\s+)?recovery\b/i,
    /\bno\s+evidence\s+(?:of|for)\s+recovery\b/i,
  ];
  return !unresolved.some((pattern) => pattern.test(recovery));
}

function appendMatchingUncertainty(form: CompactReport, findings: FindingComparison[]): void {
  const uncertain = findings.filter((finding) => finding.kind === "uncertain");
  if (!uncertain.length) {
    return;
  }
  const reasons = [
    ...new Set(
      uncertain.map((finding) => finding.reason || "Prior investigation lookup is incomplete"),
    ),
  ];
  const notice = `History matching uncertain: ${reasons.join("; ")}`;
  form.evidence.note = form.evidence.note ? `${form.evidence.note} · ${notice}` : notice;
}

function actionWithOwners(form: CompactReport, updates: CompletedInvestigation[]): string {
  if (updates.length === 1) {
    return `${form.nextAction} · Owner: ${updates[0]!.facts.owner?.name ?? "Unassigned"}`;
  }
  const owners = updates.map(
    (update) => `${update.task} — ${update.facts.owner?.name ?? "Unassigned"}`,
  );
  return `${form.nextAction} · Owners: ${owners.join("; ")}`;
}

function linkText(link: CompactReport["evidence"]["links"][number]): string {
  // URL delimiters are encoded independently of labels; prose cannot author a Slack mention or link.
  const url = escapeSlackMrkdwn(link.url.replaceAll("|", "%7C"));
  return `<${url}|${escapeSlackMrkdwn(link.label ?? "View evidence")}>`;
}

/** One typed projection owns both visible Slack fields and their complete fallback text. */
export function prepareCompactReport(
  value: unknown,
  updates: CompletedInvestigation[],
  findings: FindingComparison[],
): PreparedCompactReport {
  if (updates.length === 0 || updates.length > 20 || findings.length !== updates.length) {
    throw new Error("Compact report requires one to twenty typed findings with matching coverage.");
  }
  const parsed = compactReportSchema.safeParse(
    value === undefined ? deriveLegacyForm(updates, findings) : value,
  );
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "form";
    throw new Error(
      `Compact report ${field} is invalid; check required fields, allowed values and field limits.`,
    );
  }
  const form = parsed.data;
  appendMatchingUncertainty(form, findings);
  try {
    assertNoSensitiveContent(form);
  } catch {
    throw new Error(
      "Compact report contains sensitive content; remove credentials and raw secrets.",
    );
  }

  const allowed = citedUrls(updates, findings);
  const links = new Map<string, CompactReport["evidence"]["links"][number]>();
  for (const link of form.evidence.links) {
    const url = httpsUrl(link.url);
    if (!allowed.has(url)) {
      throw new Error("Compact report links must come from typed investigation evidence.");
    }
    if (!links.has(url)) {
      links.set(url, { ...link, url });
    }
  }
  for (const finding of findings) {
    if (
      (finding.kind === "known-persistence" || finding.kind === "changed") &&
      finding.canonicalThreadUrl
    ) {
      const url = httpsUrl(finding.canonicalThreadUrl);
      if (!links.has(url)) {
        links.set(url, { url, label: "Prior investigation" });
      }
    }
  }
  for (const update of updates) {
    if (update.facts.owner) {
      const url = httpsUrl(update.facts.owner.evidenceUrl);
      if (!links.has(url)) {
        links.set(url, { url, label: "Owner acceptance" });
      }
    }
  }
  form.evidence.links = [...links.values()];

  if (form.badge?.kind === "known-issue" && !allKnown(findings)) {
    throw new Error(
      "Compact report Known issue badge requires all findings to match existing canonical investigations.",
    );
  }
  if (form.badge?.evidenceUrl) {
    const url = httpsUrl(form.badge.evidenceUrl);
    if (!allowed.has(url)) {
      throw new Error("Compact report badge requires supporting typed evidence.");
    }
    form.badge.evidenceUrl = url;
  }
  if (form.badge?.kind === "resolved") {
    if (updates.some((update) => !hasAssertedRecovery(update.facts.recovery))) {
      throw new Error("Compact report Resolved badge requires recovery facts for every issue.");
    }
    const url = form.badge.evidenceUrl;
    if (
      !url ||
      !updates.every((update) =>
        update.evidenceUrls.some((candidate) => httpsUrl(candidate) === url),
      )
    ) {
      throw new Error(
        "Compact report Resolved badge requires supporting typed recovery evidence for every issue.",
      );
    }
    if (!links.has(url)) {
      form.evidence.links.push({ url, label: "Recovery evidence" });
    }
  }

  return renderCompactReport(form, updates);
}

function renderCompactReport(
  form: CompactReport,
  updates: CompletedInvestigation[],
): PreparedCompactReport {
  const priority = {
    unknown: "Unknown",
    low: "Low",
    medium: "Medium",
    high: "High",
    critical: "Critical",
  }[form.priority];
  const badge = form.badge
    ? { "known-issue": "Known issue", blocked: "Blocked", resolved: "Resolved" }[form.badge.kind]
    : undefined;
  const evidence = [
    form.evidence.links.length
      ? form.evidence.links.map(linkText).join(" · ")
      : "No verified evidence links supplied",
    form.evidence.checkedWindow
      ? `Checked window: ${escapeSlackMrkdwn(form.evidence.checkedWindow)}`
      : "Checked window unknown",
    ...(form.evidence.note ? [escapeSlackMrkdwn(form.evidence.note)] : []),
  ].join(" · ");
  const sections = [
    `*Title:* ${escapeSlackMrkdwn(form.title)}`,
    `*Priority:* ${priority}${badge ? ` · ${badge}` : ""}`,
    `*Next action:* ${escapeSlackMrkdwn(actionWithOwners(form, updates))}`,
    `*Summary:* ${escapeSlackMrkdwn(form.summary)}`,
    `*Evidence:* ${evidence}`,
  ];
  const text = sections.join("\n\n");
  if (
    sections.some((section) => section.length > 3_000) ||
    Buffer.byteLength(text, "utf8") > SLACK_EDIT_TEXT_MAX_BYTES
  ) {
    throw new Error(
      "Compact report exceeds Slack field or message limits; shorten the summary, action or evidence without omitting material facts.",
    );
  }
  const blocks: SectionBlock[] = sections.map((section) => ({
    type: "section",
    text: { type: "mrkdwn", text: section, verbatim: true },
  }));
  return {
    form,
    text,
    card: {
      blocks: [],
      // Model priority never grants verified active-critical styling.
      attachment: { color: form.badge?.kind === "resolved" ? "#2E8B57" : "#9CA3AF", blocks },
      fallbackText: text,
    },
  };
}

/** Delivery warnings stay within the same canonical five-field projection. */
export function appendCompactReportNotice(
  prepared: Pick<PreparedCompactReport, "form">,
  updates: CompletedInvestigation[],
  notice: string,
): PreparedCompactReport {
  const form = structuredClone(prepared.form);
  try {
    assertNoSensitiveContent(notice);
  } catch {
    throw new Error(
      "Compact report notice contains sensitive content; remove credentials and raw secrets.",
    );
  }
  form.evidence.note = [form.evidence.note, notice.trim()].filter(Boolean).join(" · ");
  return renderCompactReport(form, updates);
}
