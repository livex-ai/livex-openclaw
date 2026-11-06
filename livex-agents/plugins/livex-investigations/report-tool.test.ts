import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTestRegistry,
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oncallReportProfile, withOncallReportProfile } from "./profile.test-support.js";
import { createInvestigationRecordTool } from "./report-tool.js";
import { closeInvestigationTurnRegistry, getInvestigationTurnRegistry } from "./runtime.js";
import {
  createIssueId,
  serializeCatalog,
  type CatalogIssue,
  type CompletedInvestigation,
  type HistoryScope,
} from "./schema.js";
const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const sessionKey = "agent:oncall:slack:channel:c1";
const update: CompletedInvestigation = {
  signature: {
    scope,
    service: "api",
    environment: "prod",
    operation: "variant",
    error: "variant_name",
  },
  task: "Variant lookup",
  status: "open",
  historySummary: "Verified variant_name persists",
  waitingOn: "Owner unknown",
  prs: [],
  slackThreads: [],
  jiraTickets: [],
  facts: { finding: "Unknown variant_name", impact: "One job", nextAction: "Fix field mapping" },
  evidenceUrls: [],
};
function context(extra: Partial<OpenClawPluginToolContext<2>> = {}): OpenClawPluginToolContext<2> {
  return {
    agentId: "oncall",
    agentAccountId: "default",
    messageChannel: "slack",
    nativeChannelId: "C1",
    requesterSenderId: "U1",
    sessionKey,
    toolBindings: { slack_investigation: { turnId: "one" } },
    assertInvocationCurrent() {},
    ...extra,
  };
}
beforeEach(() => setActivePluginRegistry(withOncallReportProfile(createTestRegistry([]))));
function register() {
  getInvestigationTurnRegistry().register({
    id: "one",
    scope,
    sessionKey,
    filePath: "/tmp/synthetic-catalog.md",
    snapshot: { status: "ready", scope, revision: "r", issues: [] },
    reportProfile: oncallReportProfile,
    assertCurrent() {},
  });
}
const roots: string[] = [];
afterEach(async () => {
  closeInvestigationTurnRegistry();
  resetPluginRuntimeStateForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function renderedText(details: unknown): string {
  const value =
    details && typeof details === "object" && "finalText" in details
      ? details.finalText
      : undefined;
  expect(value).toBeTypeOf("string");
  return typeof value === "string" ? value : "";
}
const typedReport = {
  title: "Variant lookup fails",
  priority: "unknown",
  summary: "Unknown variant_name affects one job; wider impact is unknown.",
  nextAction: "Fix field mapping.",
  evidence: { links: [], note: "Evidence unavailable." },
};
describe("Slack investigation record tool", () => {
  it("stages the typed report and returns the host-rendered final", async () => {
    register();
    const result = await createInvestigationRecordTool(context()).execute("stage", {
      action: "prepare_update",
      report: typedReport,
      updates: [update],
    });
    const text = renderedText(result.details);
    expect(text).toContain("*Next action:*");
    expect(text).toContain("*Summary:*");
    expect(text).not.toContain("*Finding:*");
    expect(getInvestigationTurnRegistry().matchFinal("one", text)?.report?.state).toMatchObject({
      title: typedReport.title,
    });
  });
  it.each(["Markers: eyes warning verified.", "**Limits:** Some source fields unavailable."])(
    "uses typed facts for legacy acknowledgement without parsing %s",
    async (footer) => {
      register();
      const legacy = `⚠️ Priority unknown · Action required\n**Finding:** Old prose\n**Action:** Old prose\n${footer}`;
      const result = await createInvestigationRecordTool(context()).execute("stage", {
        action: "prepare_update",
        finalText: legacy,
        updates: [update],
      });
      const text = renderedText(result.details);
      expect(text).toContain("Unknown variant_name");
      expect(text).not.toContain(footer);
      expect(text).not.toContain("Old prose");
      expect(getInvestigationTurnRegistry().matchFinal("one", legacy)?.finalText).toBe(text);
    },
  );
  it("invalidates an older preparation when a later report is invalid", async () => {
    register();
    const tool = createInvestigationRecordTool(context());
    await tool.execute("first", {
      action: "prepare_update",
      finalText: "First acknowledgement",
      updates: [update],
    });
    await expect(
      tool.execute("invalid", {
        action: "prepare_update",
        report: { ...typedReport, priority: "P0" },
        updates: [update],
      }),
    ).rejects.toThrow(/report|priority/i);
    expect(
      getInvestigationTurnRegistry().matchFinal("one", "First acknowledgement"),
    ).toBeUndefined();
  });
  it("rejects competing report and legacy text inputs without leaving staged facts", async () => {
    register();
    await expect(
      createInvestigationRecordTool(context()).execute("stage", {
        action: "prepare_update",
        report: typedReport,
        finalText: "Competing acknowledgement",
        updates: [update],
      }),
    ).rejects.toThrow(/report.*finalText|finalText.*report/);
    expect(
      getInvestigationTurnRegistry().matchFinal("one", "Competing acknowledgement"),
    ).toBeUndefined();
  });
  it("retrieves issue 21 by ID with its latest facts while hiding foreign-scope IDs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "slack-record-selector-"));
    roots.push(root);
    const filePath = path.join(root, "investigations.md");
    const makeIssue = (index: number, issueScope = scope): CatalogIssue => {
      const signature = { ...update.signature, scope: issueScope, error: `error-${index}` };
      const canonical = "https://example.slack.com/archives/C1/p1000000000000000";
      return {
        issueId: createIssueId(signature),
        signature,
        task: update.task,
        status: update.status,
        whatWeDidLast: [
          {
            completedAt: "2026-10-21T10:00:00-07:00",
            summary: update.historySummary,
            kind: "new",
            facts: update.facts,
            evidenceUrls: [],
            reportUrl: canonical,
          },
        ],
        waitingOn: update.waitingOn,
        prs: [],
        slackThreads: [canonical],
        jiraTickets: [],
        lastUpdated: "2026-10-21T10:00:00-07:00",
      };
    };
    const issues = Array.from({ length: 21 }, (_, index) => makeIssue(index));
    const foreign = makeIssue(99, { ...scope, senderId: "U2" });
    await fs.writeFile(filePath, serializeCatalog([...issues, foreign]));
    getInvestigationTurnRegistry().register({
      id: "one",
      scope,
      sessionKey,
      filePath,
      snapshot: { status: "ready", scope, revision: "r", issues },
      assertCurrent() {},
    });
    const result = await createInvestigationRecordTool(context()).execute("lookup", {
      action: "lookup",
      issueIds: [issues[20]!.issueId, foreign.issueId],
    });
    expect(result.details).toMatchObject({
      issues: [
        { issueId: issues[20]!.issueId, latest: { facts: update.facts }, historyEntries: 1 },
      ],
    });
  });

  it("keeps a stable tool definition when no turn is bound, but refuses execution", async () => {
    const tool = createInvestigationRecordTool(context({ toolBindings: undefined }));
    expect(tool.name).toBe("slack_investigation_record");
    await expect(tool.execute("lookup", { action: "lookup" })).rejects.toThrow(/bound/);
  });
  it("stages validated findings for the exact final without writing the catalog", async () => {
    register();
    const tool = createInvestigationRecordTool(context());
    const result = await tool.execute("stage", {
      action: "prepare_update",
      finalText: "Final finding",
      updates: [update],
    });
    expect(result.details).toMatchObject({ status: "prepared", findings: [{ kind: "new" }] });
    expect(getInvestigationTurnRegistry().matchFinal("one", "Final finding")?.updates).toEqual([
      update,
    ]);
  });
  it("merges the verified canonical link into the host-rendered known-issue report", async () => {
    const canonical = "https://example.slack.com/archives/C1/p1000000000000000";
    getInvestigationTurnRegistry().register({
      id: "one",
      reportProfile: oncallReportProfile,
      scope,
      sessionKey,
      filePath: "/tmp/synthetic-catalog.md",
      snapshot: {
        status: "ready",
        scope,
        revision: "r",
        issues: [
          {
            issueId: "issue-known",
            signature: update.signature,
            task: update.task,
            status: update.status,
            whatWeDidLast: [
              {
                completedAt: "2026-10-21T10:00:00-07:00",
                summary: update.historySummary,
                kind: "new",
                facts: update.facts,
                evidenceUrls: [],
                reportUrl: canonical,
              },
            ],
            waitingOn: update.waitingOn,
            prs: [],
            slackThreads: [canonical],
            jiraTickets: [],
            lastUpdated: "2026-10-21T10:00:00-07:00",
          },
        ],
      },
      assertCurrent() {},
    });
    const tool = createInvestigationRecordTool(context());
    const result = await tool.execute("stage", {
      action: "prepare_update",
      finalText: "Known issue persists",
      updates: [update],
    });
    expect(renderedText(result.details)).toContain(canonical);
    expect(result.details).toMatchObject({
      status: "prepared",
      findings: [{ kind: "known-persistence", canonicalThreadUrl: canonical }],
    });
  });
  it("rejects a caller from another sender and checks authority before staging", async () => {
    register();
    await expect(
      createInvestigationRecordTool(context({ requesterSenderId: "U2" })).execute("stage", {
        action: "prepare_update",
        finalText: "Final",
        updates: [update],
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      createInvestigationRecordTool(
        context({
          assertInvocationCurrent() {
            throw new Error("revoked");
          },
        }),
      ).execute("stage", { action: "prepare_update", finalText: "Final", updates: [update] }),
    ).rejects.toThrow("revoked");
    expect(getInvestigationTurnRegistry().matchFinal("one", "Final")).toBeUndefined();
  });
});
