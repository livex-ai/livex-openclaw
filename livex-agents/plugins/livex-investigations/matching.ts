import {
  hasCompleteSignature,
  normalizeSignature,
  scopeMatches,
  signatureKey,
  type CatalogIssue,
  type CatalogSnapshot,
  type CompletedInvestigation,
  type FindingKind,
  type InvestigationFacts,
} from "./schema.js";

export type FindingComparison = {
  kind: FindingKind;
  update: CompletedInvestigation;
  issueId?: string;
  canonicalThreadUrl?: string;
  changes: string[];
  reason?: string;
};

/** Omitting a historical decision never retracts its accepted owner or disposition. */
export function mergeFacts(
  previous: InvestigationFacts,
  update: InvestigationFacts,
): InvestigationFacts {
  return {
    ...previous,
    ...update,
    owner: update.owner ?? previous.owner,
    disposition: update.disposition ?? previous.disposition,
    recovery: update.recovery ?? previous.recovery,
    evidence: update.evidence ?? previous.evidence,
  };
}

export function trackingFields(
  issue: CatalogIssue,
  update: CompletedInvestigation,
): Pick<CatalogIssue, "status" | "waitingOn"> {
  const prior = issue.whatWeDidLast.at(-1)!.facts;
  const normalize = (value: string | undefined) => value?.trim().replace(/\s+/g, " ") ?? "";
  const hasPriorDecision = Boolean(prior.owner || prior.disposition);
  const decisionChanged =
    ["disposition", "recovery"].some((key) => {
      const field = key as "disposition" | "recovery";
      return (
        update.facts[field] !== undefined &&
        normalize(prior[field]) !== normalize(update.facts[field])
      );
    }) ||
    (update.facts.owner !== undefined &&
      normalize(prior.owner?.name) !== normalize(update.facts.owner.name));
  if (!hasPriorDecision || decisionChanged) {
    return { status: update.status, waitingOn: update.waitingOn };
  }
  const newAction = prior.nextAction.trim() !== update.facts.nextAction.trim();
  return {
    status: issue.status,
    waitingOn: newAction
      ? `${issue.waitingOn}\nLatest required action: ${update.facts.nextAction}`
      : issue.waitingOn,
  };
}

function meaningfulChanges(issue: CatalogIssue, update: CompletedInvestigation): string[] {
  const previous = issue.whatWeDidLast.at(-1)!.facts;
  const next = mergeFacts(previous, update.facts);
  const normalize = (value: string | undefined) => value?.trim().replace(/\s+/g, " ") ?? "";
  const changes: string[] = [];
  for (const key of [
    "finding",
    "impact",
    "nextAction",
    "evidence",
    "disposition",
    "recovery",
  ] as const) {
    if (normalize(previous[key]) !== normalize(next[key])) {
      changes.push(key);
    }
  }
  if (normalize(previous.owner?.name) !== normalize(next.owner?.name)) {
    changes.push("owner");
  }
  const tracking = trackingFields(issue, update);
  for (const key of ["status", "waitingOn"] as const) {
    if (normalize(issue[key]) !== normalize(tracking[key])) {
      changes.push(key);
    }
  }
  for (const key of ["prs", "jiraTickets"] as const) {
    if (update[key].some((url) => !issue[key].includes(url))) {
      changes.push(key);
    }
  }
  return changes;
}

export function compareFindings(
  snapshot: CatalogSnapshot,
  updates: CompletedInvestigation[],
): FindingComparison[] {
  return updates.map((update): FindingComparison => {
    const base = { update, changes: [] };
    if (snapshot.status !== "ready") {
      return {
        ...base,
        kind: "uncertain",
        reason: snapshot.reason ?? `History ${snapshot.status}`,
      };
    }
    if (
      !scopeMatches(snapshot.scope, update.signature.scope) ||
      !hasCompleteSignature(update.signature)
    ) {
      return { ...base, kind: "uncertain", reason: "Missing or conflicting investigation scope" };
    }
    const exact = snapshot.issues.filter(
      (issue) => signatureKey(issue.signature) === signatureKey(update.signature),
    );
    if (exact.length > 1) {
      return { ...base, kind: "uncertain", reason: "Several investigations match this signature" };
    }
    const issue = exact[0];
    if (issue) {
      const changes = meaningfulChanges(issue, update);
      return {
        ...base,
        kind: changes.length ? "changed" : "known-persistence",
        issueId: issue.issueId,
        canonicalThreadUrl: issue.slackThreads[0],
        changes,
      };
    }
    const error = normalizeSignature(update.signature).error;
    if (
      snapshot.issues.some((candidate) => normalizeSignature(candidate.signature).error === error)
    ) {
      return {
        ...base,
        kind: "uncertain",
        reason: "Similar error has conflicting service, operation or resource context",
      };
    }
    return { ...base, kind: "new" };
  });
}
