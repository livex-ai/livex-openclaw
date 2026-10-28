import type { FindingComparison } from "./matching.js";
import type { CompletedInvestigation } from "./schema.js";
/** Project validated facts only; no catalog signatures, history or host paths cross the profile boundary. */
export function reportContext(updates: CompletedInvestigation[], findings: FindingComparison[]) {
  return {
    updates: updates.map(({ task, facts, prs, slackThreads, jiraTickets, evidenceUrls }) => ({
      task,
      facts,
      prs,
      slackThreads,
      jiraTickets,
      evidenceUrls,
    })),
    findings: findings.map(({ kind, canonicalThreadUrl, reason }) => ({
      kind,
      canonicalThreadUrl,
      reason,
    })),
  };
}
