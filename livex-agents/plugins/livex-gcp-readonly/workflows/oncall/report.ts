import { prepareCompactReport, type CompactReport } from "@livex/oncall-reports/compact-report";
import { safeText } from "./policy.js";
import type { Alert, Finding } from "./types.js";

export function renderOncallFinding(finding: Finding, alert: Alert, notice?: string) {
  try {
    return prepareFinding(finding, alert, notice);
  } catch {
    return prepareFinding(
      {
        classification: "unclassified",
        reason: "Finding could not be displayed safely. Review the investigation.",
      },
      alert,
      notice,
    );
  }
}

function selectEvidence(evidence: string[]) {
  const links: CompactReport["evidence"]["links"] = [];
  let remaining = 1_650;
  for (const url of evidence) {
    const cost = Buffer.byteLength(url, "utf8") + 32;
    if (cost <= remaining) {
      links.push({ url, label: "GCP evidence" });
      remaining -= cost;
    }
  }
  return links;
}

function prepareFinding(finding: Finding, alert: Alert, notice?: string) {
  const signature = finding.signature;
  const title = signature
    ? safeText(`${signature.service} · ${signature.operation}`, 150)
    : "Investigation requires review";
  const summary = safeText(
    finding.summary ?? finding.reason ?? "Investigation requires human review",
  );
  const nextAction = safeText(finding.nextAction ?? "Review the investigation outcome");
  const priority = (finding.priority ?? "Unknown").toLowerCase() as CompactReport["priority"];
  const evidence = [...new Set(finding.evidence)];
  const links = selectEvidence(evidence);
  const note = [
    `Case classification: ${finding.classification}`,
    `Alert window: ${alert.start} – ${alert.end}`,
  ];
  if (links.length < evidence.length) {
    note.push(`${evidence.length - links.length} evidence links omitted to fit Slack`);
  }
  if (notice) {
    note.push(notice);
  }
  const canonicalThreadUrl = finding.classification === "known" ? finding.caseUrl : undefined;
  const form: CompactReport = {
    title,
    priority,
    summary,
    nextAction,
    evidence: {
      links,
      note: note.join(" · "),
    },
    ...(canonicalThreadUrl
      ? { badge: { kind: "known-issue" } }
      : !finding.summary
        ? { badge: { kind: "blocked" } }
        : {}),
  };
  return prepareCompactReport(
    form,
    [
      {
        task: title,
        facts: { finding: summary, impact: "", nextAction },
        prs: [],
        slackThreads: [],
        jiraTickets: [],
        evidenceUrls: links.map(({ url }) => url),
      },
    ],
    [
      canonicalThreadUrl
        ? { kind: "known-persistence", canonicalThreadUrl }
        : finding.classification === "unknown"
          ? { kind: "new" }
          : { kind: "uncertain", reason: finding.reason && safeText(finding.reason) },
    ],
  );
}
