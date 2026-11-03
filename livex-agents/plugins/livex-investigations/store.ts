import { createHash } from "node:crypto";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import type { ReportAmendment } from "openclaw/plugin-sdk/reply-turns";
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
  saved?: number;
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

const catalogLockOptions = {
  retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 100 },
  stale: 30_000,
  staleRecovery: "remove-if-definitely-stale" as const,
};
const lockCase = (path: string, id: string) =>
  acquireFileLock(path + ".case-" + id, {
    ...catalogLockOptions,
    retries: { retries: 65, factor: 1.4, minTimeout: 20, maxTimeout: 500 },
  });

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
  const cases: Awaited<ReturnType<typeof lockCase>>[] = [];
  try {
    for (const id of [...new Set(params.updates.map((u) => createIssueId(u.signature)))].sort()) {
      cases.push(await lockCase(params.filePath, id));
    }
    lock = await acquireFileLock(params.filePath, catalogLockOptions);
    const document = await readDocument(params.filePath);
    assertCurrent();
    if (document.status !== "ready") {
      return { ...document, status: document.status, issues: [] };
    }
    const issues = [...document.issues];
    const comparisons = compareFindings(
      {
        ...document,
        scope: params.scope,
        issues: document.issues.filter((issue) =>
          scopeMatches(issue.signature.scope, params.scope),
        ),
      },
      params.updates,
    );
    let saved = 0;
    let skipped = 0;
    const completedAt = pacificDate(params.now);
    for (const comparison of comparisons) {
      const update = comparison.update;
      if (comparison.kind === "uncertain") {
        skipped++;
        continue;
      }
      const issueId = comparison.issueId ?? createIssueId(update.signature);
      const priorIndex = issues.findIndex((issue) => issue.issueId === issueId);
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
        issueId,
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
      saved++;
    }
    const visibleIssues = issues.filter((issue) =>
      scopeMatches(issue.signature.scope, params.scope),
    );
    if (!saved) {
      return {
        status: skipped ? "partial" : "unchanged",
        revision: document.revision,
        issues: visibleIssues,
        saved,
        skipped,
        ...(skipped ? { reason: "Uncertain or capacity-limited findings were not recorded" } : {}),
      };
    }
    const content = serializeCatalog(issues);
    assertCurrent();
    await saveCatalog(params.filePath, content, assertCurrent);
    return {
      status: skipped ? "partial" : "committed",
      revision: revisionOf(content),
      issues: visibleIssues,
      saved,
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
    try {
      await lock?.release();
    } finally {
      await Promise.all(cases.map((c) => c.release()));
    }
  }
}

async function saveCatalog(filePath: string, content: string, assertCurrent: () => void) {
  await replaceFileAtomic({
    filePath: filePath,
    content,
    mode: 0o600,
    preserveExistingMode: false,
    tempPrefix: `${path.basename(filePath)}.write`,
    syncTempFile: true,
    syncParentDir: true,
    beforeRename: async () => {
      assertCurrent();
    },
  });
}

/** Serialize edits against case publication. Stage valid history before the Slack write;
 * publish it only when the transport confirms the canonical edited message. */
export async function editCatalogReport(params: {
  filePath: string;
  scope: HistoryScope;
  threadId: string;
  messageId: string;
  changes: ReportAmendment;
  snapshot: CatalogSnapshot;
  assertCurrent: () => void;
  edit: (url: string) => Promise<void>;
}) {
  const { filePath, scope, threadId, messageId, changes, assertCurrent } = params;
  assertCurrent();
  // Serialize edits to this thread without blocking saves for independent cases during Slack I/O.
  const threadKey = createHash("sha256")
    .update(JSON.stringify([scope.teamId, scope.channelId, threadId]))
    .digest("hex");
  const lock = await acquireFileLock(filePath + ".edit-" + threadKey, catalogLockOptions);
  let caseLock: Awaited<ReturnType<typeof lockCase>> | undefined;
  try {
    const stage = async () => {
      const doc = await readDocument(filePath);
      if (doc.status !== "ready") throw new Error("Case history unavailable");
      const scoped = doc.issues.filter((issue) => scopeMatches(issue.signature.scope, scope));
      const scopeOf = (raw: string | undefined) => {
        if (!raw) return "other";
        const url = new URL(raw);
        if (
          url.protocol !== "https:" ||
          !url.hostname.endsWith(".slack.com") ||
          !url.pathname.startsWith(`/archives/${scope.channelId}/p`)
        )
          return "other";
        const root = url.searchParams.get("thread_ts");
        return root === threadId ? "same" : root === null ? "unknown" : "other";
      };
      const exact = scoped.filter((issue) =>
        issue.slackThreads.some((raw) => scopeOf(raw) === "same"),
      );
      // Older Slack permalinks can be bare. A single candidate is still subject
      // to exact thread membership verification by the authenticated transport.
      const matches = exact.length
        ? exact
        : scoped.filter((issue) => scopeOf(issue.slackThreads[0]) === "unknown");
      const [issue] = matches;
      if (!issue || matches.length !== 1) {
        throw new Error("Cannot identify one case in this thread");
      }
      const url = issue.slackThreads[0];
      // Slack may supply a bare permalink or add thread_ts/cid to the same message.
      const messageKey = (link: string) => {
        const parsed = new URL(link);
        return parsed.origin + parsed.pathname;
      };
      if (
        !url ||
        scopeOf(url) === "other" ||
        issue.whatWeDidLast[0]?.reportUrl !== url ||
        doc.issues.some(
          (other) =>
            other !== issue &&
            other.slackThreads.some((link) => messageKey(link) === messageKey(url)),
        )
      )
        throw new Error("Ambiguous canonical report");
      const requestUrl = new URL(url);
      requestUrl.pathname = "/archives/" + scope.channelId + "/p" + messageId.replace(".", "");
      requestUrl.search = "";
      const receipt = requestUrl.href;
      const summary =
        "Report amended by " +
        scope.senderId +
        ": " +
        JSON.stringify(changes) +
        " (Slack " +
        messageId +
        ").";
      const previous = issue.whatWeDidLast.find(
        (entry) =>
          entry.evidenceUrls.includes(receipt) &&
          entry.summary.endsWith("(Slack " + messageId + ")."),
      );
      if (previous) {
        if (previous.summary !== summary) throw new Error("Conflicting replay of report amendment");
        return { url, id: issue.issueId };
      }
      if (
        issue.whatWeDidLast.some((entry) => {
          const newer = /\(Slack (\d{10}\.\d{6})\)\.$/.exec(entry.summary)?.[1];
          return newer && newer > messageId && entry.summary.startsWith("Report amended by ");
        })
      )
        throw new Error("A later report change already supersedes this request");
      const observed = params.snapshot.issues.find((i) => i.issueId === issue.issueId);
      if (!observed || JSON.stringify(observed) !== JSON.stringify(issue))
        throw new Error("Case changed since request preparation");
      const last = issue.whatWeDidLast.at(-1)!;
      const facts = { ...last.facts };
      if (changes.priority) facts.priority = changes.priority;
      if (changes.nextAction) facts.nextAction = changes.nextAction;
      if (changes.acceptOwnership) facts.owner = { name: scope.senderId, evidenceUrl: receipt };
      if (issue.waitingOn === last.facts.nextAction) issue.waitingOn = facts.nextAction;
      else if (
        changes.acceptOwnership &&
        /^(?:unassigned|owner (?:unknown|acceptance unknown))$/i.test(issue.waitingOn)
      )
        issue.waitingOn = facts.nextAction;
      const completedAt = pacificDate(new Date());
      issue.whatWeDidLast.push({
        ...last,
        facts,
        evidenceUrls: [...new Set([...last.evidenceUrls, receipt])],
        completedAt,
        kind: "changed",
        summary,
        reportUrl: url,
      });
      issue.lastUpdated = completedAt;
      return { url, id: issue.issueId, content: serializeCatalog(doc.issues) };
    };
    const before = await stage();
    assertCurrent();
    if (!before.content) return;
    caseLock = await lockCase(filePath, before.id);
    const current = await stage();
    if (!current.content) return;
    if (current.id !== before.id || current.url !== before.url)
      throw new Error("Canonical case changed");
    assertCurrent();
    await params.edit(before.url);
    assertCurrent();
    const writer = await acquireFileLock(filePath, catalogLockOptions);
    try {
      const after = await stage();
      if (after.id !== before.id || after.url !== before.url)
        throw new Error("Canonical case changed during edit");
      if (after.content) await saveCatalog(filePath, after.content, assertCurrent);
    } finally {
      await writer.release();
    }
  } finally {
    try {
      await caseLock?.release();
    } finally {
      await lock.release();
    }
  }
}
