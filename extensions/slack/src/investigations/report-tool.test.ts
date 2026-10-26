import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
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
function register() {
  getInvestigationTurnRegistry().register({
    id: "one",
    scope,
    sessionKey,
    filePath: "/tmp/synthetic-catalog.md",
    snapshot: { status: "ready", scope, revision: "r", issues: [] },
    assertCurrent() {},
  });
}
const roots: string[] = [];
afterEach(async () => {
  closeInvestigationTurnRegistry();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe("Slack investigation record tool", () => {
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
  it("requires the existing canonical investigation link before staging a known-issue final", async () => {
    const canonical = "https://example.slack.com/archives/C1/p1000000000000000";
    getInvestigationTurnRegistry().register({
      id: "one",
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
    await expect(
      tool.execute("stage", {
        action: "prepare_update",
        finalText: "Known issue persists",
        updates: [update],
      }),
    ).rejects.toThrow(/canonical investigation link/);
    expect(
      getInvestigationTurnRegistry().matchFinal("one", "Known issue persists"),
    ).toBeUndefined();
    const result = await tool.execute("stage", {
      action: "prepare_update",
      finalText: `Known issue persists: ${canonical}`,
      updates: [update],
    });
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
