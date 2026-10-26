import { createHash } from "node:crypto";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import {
  extractErrorCode,
  readRegularFile,
  replaceFileAtomic,
} from "openclaw/plugin-sdk/security-runtime";
import { compareFindings, mergeFacts, trackingFields } from "./matching.js";
import {
  CatalogLimitError,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ISSUES,
  MAX_ISSUE_HISTORY,
  createIssueId,
  normalizeSignature,
  parseCatalog,
  scopeMatches,
  serializeCatalog,
  type CatalogIssue,
  type CatalogSnapshot,
  type CatalogStatus,
  type CompletedInvestigation,
  type HistoryScope,
} from "./schema.js";

export type CommitInvestigationsResult = {
  status: "committed" | "unchanged" | Exclude<CatalogStatus, "ready">;
  revision: string | null;
  issues: CatalogIssue[];
  skipped?: number;
  reason?: string;
};

type CatalogDocument = Omit<CatalogSnapshot, "scope">;
const revisionOf = (content: string) => createHash("sha256").update(content).digest("hex");

async function readDocument(filePath: string): Promise<CatalogDocument> {
  let source: string;
  try {
    source = (await readRegularFile({ filePath, maxBytes: MAX_CATALOG_BYTES })).buffer.toString(
      "utf8",
    );
  } catch (error) {
    const code = extractErrorCode(error);
    const missing = code === "not-found" || code === "ENOENT";
    return {
      status: missing ? "uninitialized" : code === "too-large" ? "partial" : "unavailable",
      revision: null,
      issues: [],
      reason: missing
        ? "Catalog has not been initialized"
        : code === "too-large"
          ? "Catalog exceeds the byte limit"
          : "Catalog cannot be read safely",
    };
  }
  const revision = revisionOf(source);
  try {
    return { status: "ready", revision, issues: parseCatalog(source) };
  } catch (error) {
    return {
      status: error instanceof CatalogLimitError ? "partial" : "corrupt",
      revision,
      issues: [],
      reason:
        error instanceof CatalogLimitError
          ? error.message
          : "Catalog schema or record content is invalid",
    };
  }
}

export async function readCatalog(params: {
  filePath: string;
  scope: HistoryScope;
}): Promise<CatalogSnapshot> {
  const document = await readDocument(params.filePath);
  return {
    ...document,
    scope: params.scope,
    issues: document.issues.filter((issue) => scopeMatches(issue.signature.scope, params.scope)),
  };
}

function pacificDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === kind)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${part("timeZoneName").replace("GMT", "")} [America/Los_Angeles]`;
}

const unique = (values: string[]) => [...new Set(values)];

export async function commitInvestigations(params: {
  filePath: string;
  scope: HistoryScope;
  updates: CompletedInvestigation[];
  reportUrl: string;
  now: Date;
  assertCurrent: () => void;
}): Promise<CommitInvestigationsResult> {
  // The Slack delivery owner supplies this verified receipt; a URL by itself never authorizes publication.
  let authorityFailed = false;
  const assertCurrent = () => {
    try {
      params.assertCurrent();
    } catch (error) {
      authorityFailed = true;
      throw error;
    }
  };
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    lock = await acquireFileLock(params.filePath, {
      retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 100 },
      stale: 30_000,
      staleRecovery: "remove-if-definitely-stale",
    });
    const document = await readDocument(params.filePath);
    assertCurrent();
    if (document.status !== "ready") {
      return { ...document, status: document.status, issues: [] };
    }
    const issues = [...document.issues];
    let changed = false;
    let skipped = 0;
    const completedAt = pacificDate(params.now);
    for (const update of params.updates) {
      const visibleIssues = issues.filter((issue) =>
        scopeMatches(issue.signature.scope, params.scope),
      );
      const comparison = compareFindings(
        { ...document, scope: params.scope, issues: visibleIssues },
        [update],
      )[0]!;
      if (comparison.kind === "uncertain") {
        skipped++;
        continue;
      }
      const priorIndex = comparison.issueId
        ? issues.findIndex((issue) => issue.issueId === comparison.issueId)
        : -1;
      const previous = issues[priorIndex];
      if (previous?.whatWeDidLast.some((entry) => entry.reportUrl === params.reportUrl)) {
        continue;
      }
      if (
        (!previous && issues.length >= MAX_CATALOG_ISSUES) ||
        (previous && previous.whatWeDidLast.length >= MAX_ISSUE_HISTORY)
      ) {
        skipped++;
        continue;
      }
      const history = {
        completedAt,
        summary: update.historySummary,
        kind: comparison.kind,
        facts: previous
          ? mergeFacts(previous.whatWeDidLast.at(-1)!.facts, update.facts)
          : update.facts,
        evidenceUrls: update.evidenceUrls,
        reportUrl: params.reportUrl,
      };
      const tracking = previous ? trackingFields(previous, update) : update;
      const issue: CatalogIssue = {
        issueId: previous?.issueId ?? createIssueId(update.signature),
        signature: previous?.signature ?? normalizeSignature(update.signature),
        task: update.task,
        status: tracking.status,
        whatWeDidLast: [...(previous?.whatWeDidLast ?? []), history],
        waitingOn: tracking.waitingOn,
        prs: unique([...(previous?.prs ?? []), ...update.prs]),
        slackThreads: unique([
          ...(previous?.slackThreads ?? [params.reportUrl]),
          ...update.slackThreads,
          params.reportUrl,
        ]),
        jiraTickets: unique([...(previous?.jiraTickets ?? []), ...update.jiraTickets]),
        lastUpdated:
          previous && comparison.kind === "known-persistence" ? previous.lastUpdated : completedAt,
      };
      if (previous) {
        issues[priorIndex] = issue;
      } else {
        issues.push(issue);
      }
      changed = true;
    }
    const visibleIssues = issues.filter((issue) =>
      scopeMatches(issue.signature.scope, params.scope),
    );
    if (!changed) {
      return {
        status: skipped ? "partial" : "unchanged",
        revision: document.revision,
        issues: visibleIssues,
        skipped,
        ...(skipped ? { reason: "Uncertain or capacity-limited findings were not recorded" } : {}),
      };
    }
    const content = serializeCatalog(issues);
    assertCurrent();
    await replaceFileAtomic({
      filePath: params.filePath,
      content,
      mode: 0o600,
      preserveExistingMode: false,
      tempPrefix: `${path.basename(params.filePath)}.write`,
      syncTempFile: true,
      syncParentDir: true,
      beforeRename: async () => {
        assertCurrent();
      },
    });
    return {
      status: skipped ? "partial" : "committed",
      revision: revisionOf(content),
      issues: visibleIssues,
      skipped,
      ...(skipped
        ? { reason: "Valid findings recorded; uncertain or capacity-limited findings skipped" }
        : {}),
    };
  } catch (error) {
    if (authorityFailed) {
      throw error;
    }
    return {
      status: error instanceof CatalogLimitError ? "partial" : "unavailable",
      revision: null,
      issues: [],
      reason:
        error instanceof CatalogLimitError
          ? error.message
          : "Catalog update failed; publication is not confirmed",
    };
  } finally {
    await lock?.release();
  }
}
